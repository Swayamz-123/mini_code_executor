import Docker from 'dockerode';
import { performance } from 'node:perf_hooks';
import type {
  ExecutionLimits,
  ExecutionSummary,
  SingleTestResult,
  TestCase,
  Verdict,
} from '@codeforge/shared-types';
import { getDockerClient, resolveSandboxRuntime } from './docker-client.js';
import { createTarArchive, extractFileFromTar } from './tar-utils.js';

const RUNNER_IMAGE = 'codeforge-runner-cpp:latest';
const MAX_OUTPUT_BYTES = 64 * 1024; // 64 KB limit to prevent output bombs

/**
 * Demultiplexes standard Docker stream (8-byte header frame).
 */
export function demuxDockerStream(buffer: Buffer): { stdout: string; stderr: string } {
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let offset = 0;

  while (offset + 8 <= buffer.length) {
    const streamType = buffer.readUInt8(offset);
    if (streamType !== 1 && streamType !== 2 && streamType !== 0) {
      // Non-standard framing, treat whole buffer as stdout
      stdoutChunks.push(buffer.subarray(offset));
      break;
    }
    const payloadLength = buffer.readUInt32BE(offset + 4);
    offset += 8;

    const end = Math.min(offset + payloadLength, buffer.length);
    const chunk = buffer.subarray(offset, end);
    if (streamType === 2) {
      stderrChunks.push(chunk);
    } else {
      stdoutChunks.push(chunk);
    }
    offset += payloadLength;
  }

  // Cap captured length
  const stdoutBuf = Buffer.concat(stdoutChunks).subarray(0, MAX_OUTPUT_BYTES);
  const stderrBuf = Buffer.concat(stderrChunks).subarray(0, MAX_OUTPUT_BYTES);

  return {
    stdout: stdoutBuf.toString('utf8'),
    stderr: stderrBuf.toString('utf8'),
  };
}

/**
 * Normalizes output by trimming trailing whitespace per line and overall ends.
 */
export function normalizeOutput(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

/**
 * Compiles C++ source code in a sandboxed, networkless compilation container.
 */
export async function compileCpp(
  docker: Docker,
  sourceCode: string,
  timeoutMs = 15000
): Promise<{ success: true; binaryBuffer: Buffer } | { success: false; compileOutput: string }> {
  const runtime = await resolveSandboxRuntime(docker);

  const container = (await docker.createContainer({
    Image: RUNNER_IMAGE,
    Cmd: [
      '/bin/sh',
      '-c',
      'g++ -O2 -std=c++20 -Wall -Wextra solution.cpp -o solution',
    ],
    AttachStdout: true,
    AttachStderr: true,
    NetworkDisabled: true,
    User: '10001:10001',
    WorkingDir: '/sandbox/workspace',
    HostConfig: {
      NetworkMode: 'none',
      Memory: 512 * 1024 * 1024, // 512MB for compiler
      MemorySwap: 512 * 1024 * 1024,
      NanoCpus: 1_000_000_000,
      PidsLimit: 64,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      ReadonlyRootfs: false, // Compiler creates temp files & binary
      Runtime: runtime,
    },
  })) as Docker.Container;

  try {
    const archive = await createTarArchive([
      { name: 'solution.cpp', content: sourceCode, mode: 0o644 },
    ]);
    await container.putArchive(archive, { path: '/sandbox/workspace' });

    let timedOut = false;
    const timeoutHandle = setTimeout(async () => {
      timedOut = true;
      try {
        await container.kill({ signal: 'SIGKILL' });
      } catch {
        // Ignored
      }
    }, timeoutMs);

    await container.start();
    const waitResult = await container.wait();
    clearTimeout(timeoutHandle);

    const logBuffer = (await container.logs({
      stdout: true,
      stderr: true,
      follow: false,
    })) as unknown as Buffer;

    const { stdout, stderr } = demuxDockerStream(logBuffer);
    const compileOutput = (stderr + (stdout ? `\n${stdout}` : '')).trim();

    if (timedOut || waitResult.StatusCode !== 0) {
      return {
        success: false,
        compileOutput: compileOutput || (timedOut ? 'Compilation timed out.' : 'Compilation failed.'),
      };
    }

    // Extract compiled binary
    const binaryTar = (await container.getArchive({
      path: '/sandbox/workspace/solution',
    })) as NodeJS.ReadableStream;

    const chunks: Buffer[] = [];
    for await (const chunk of binaryTar) {
      chunks.push(chunk as Buffer);
    }
    const fullTar = Buffer.concat(chunks);
    const binary = await extractFileFromTar(fullTar, 'solution');

    if (!binary) {
      return {
        success: false,
        compileOutput: 'Compilation succeeded but compiled executable was not found.',
      };
    }

    return { success: true, binaryBuffer: binary };
  } finally {
    try {
      await container.remove({ force: true });
    } catch {
      // Ignored
    }
  }
}

/**
 * Runs a compiled binary against a single test case under strict sandbox limits.
 */
export async function executeTestCase(
  docker: Docker,
  binaryBuffer: Buffer,
  testCase: TestCase,
  limits: ExecutionLimits
): Promise<SingleTestResult> {
  const runtime = await resolveSandboxRuntime(docker);

  const container = (await docker.createContainer({
    Image: RUNNER_IMAGE,
    Cmd: ['/bin/sh', '-c', './solution < input.txt'],
    AttachStdout: true,
    AttachStderr: true,
    NetworkDisabled: true,
    User: '10001:10001',
    WorkingDir: '/sandbox/workspace',
    HostConfig: {
      NetworkMode: 'none',
      Memory: limits.memoryLimitKb * 1024,
      MemorySwap: limits.memoryLimitKb * 1024,
      NanoCpus: 1_000_000_000,
      PidsLimit: 32,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      ReadonlyRootfs: false, // Standard Linux permissions restrict non-root UID 10001; putArchive requires writable layer
      Tmpfs: {
        '/tmp': 'rw,noexec,nosuid,size=16m',
      },
      Runtime: runtime,
    },
  })) as Docker.Container;

  try {
    const archive = await createTarArchive([
      { name: 'solution', content: binaryBuffer, mode: 0o755 },
      { name: 'input.txt', content: testCase.input, mode: 0o644 },
    ]);
    await container.putArchive(archive, { path: '/sandbox/workspace' });

    const wallClockLimitMs = Math.max(1500, Math.floor(limits.timeLimitMs * 1.5));
    let timedOut = false;

    const timeoutHandle = setTimeout(async () => {
      timedOut = true;
      try {
        await container.kill({ signal: 'SIGKILL' });
      } catch {
        // Ignored
      }
    }, wallClockLimitMs);

    const startTime = performance.now();
    await container.start();
    const waitResult = await container.wait();
    const elapsedMs = Math.round(performance.now() - startTime);
    clearTimeout(timeoutHandle);

    const logBuffer = (await container.logs({
      stdout: true,
      stderr: true,
      follow: false,
    })) as unknown as Buffer;

    const { stdout, stderr } = demuxDockerStream(logBuffer);
    const inspect = await container.inspect();

    let verdict: Verdict;
    if (inspect.State.OOMKilled) {
      verdict = 'MEMORY_LIMIT_EXCEEDED';
    } else if (timedOut || elapsedMs > wallClockLimitMs) {
      verdict = 'TIME_LIMIT_EXCEEDED';
    } else if (waitResult.StatusCode === 137) {
      verdict = timedOut ? 'TIME_LIMIT_EXCEEDED' : 'MEMORY_LIMIT_EXCEEDED';
    } else if (waitResult.StatusCode !== 0) {
      verdict = 'RUNTIME_ERROR';
    } else {
      const match = normalizeOutput(stdout) === normalizeOutput(testCase.expectedOutput);
      verdict = match ? 'ACCEPTED' : 'WRONG_ANSWER';
    }

    return {
      testCaseId: testCase.id,
      verdict,
      timeMs: elapsedMs,
      memoryKb: Math.round((inspect.HostConfig?.Memory || limits.memoryLimitKb * 1024) / 1024),
      actualOutput: stdout.substring(0, MAX_OUTPUT_BYTES),
      errorOutput: stderr.substring(0, MAX_OUTPUT_BYTES),
    };
  } finally {
    try {
      await container.remove({ force: true });
    } catch {
      // Ignored
    }
  }
}

/**
 * End-to-end execution of a C++ submission across all test cases.
 */
export async function runCppSubmission(
  sourceCode: string,
  testCases: TestCase[],
  limits: ExecutionLimits
): Promise<ExecutionSummary> {
  const docker = getDockerClient();

  // 1. Compile
  const compileResult = await compileCpp(docker, sourceCode, 15000);
  if (!compileResult.success) {
    return {
      verdict: 'COMPILE_ERROR',
      compileOutput: compileResult.compileOutput,
      totalTimeMs: 0,
      peakMemoryKb: 0,
      testResults: [],
    };
  }

  // 2. Execute test cases sequentially (stopping on first non-ACCEPTED for fast-fail)
  const results: SingleTestResult[] = [];
  let finalVerdict: Verdict = 'ACCEPTED';
  let totalTimeMs = 0;
  let peakMemoryKb = 0;

  for (const tc of testCases) {
    const res = await executeTestCase(docker, compileResult.binaryBuffer, tc, limits);
    results.push(res);
    totalTimeMs += res.timeMs;
    peakMemoryKb = Math.max(peakMemoryKb, res.memoryKb);

    if (res.verdict !== 'ACCEPTED') {
      finalVerdict = res.verdict;
      break; // Fast-fail verdict
    }
  }

  return {
    verdict: finalVerdict,
    totalTimeMs,
    peakMemoryKb,
    testResults: results,
  };
}
