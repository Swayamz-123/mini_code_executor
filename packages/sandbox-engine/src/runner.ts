import Docker from 'dockerode';
import { performance } from 'node:perf_hooks';
import type {
  ExecutionLimits,
  ExecutionSummary,
  SingleTestResult,
  TestCase,
  Verdict,
} from '@codeforge/shared-types';
import {
  getDockerClient,
  resolveSandboxRuntime,
  type RuntimeResolutionOptions,
} from './docker-client.js';
import { createTarArchive, extractFileFromTar } from './tar-utils.js';

const RUNNER_IMAGE = 'codeforge-runner-cpp:latest';
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024; // 64 KB default limit

export interface RunnerOptions extends RuntimeResolutionOptions {
  maxOutputBytes?: number;
}

/**
 * Streaming Docker multiplex parser that enforces hard byte limits in real-time.
 * If incoming stdout or stderr exceeds maxBytes, immediately triggers onLimitExceeded.
 */
export class StreamOutputCollector {
  private buffer = Buffer.alloc(0);
  private stdoutChunks: Buffer[] = [];
  private stderrChunks: Buffer[] = [];
  public stdoutBytes = 0;
  public stderrBytes = 0;
  public outputLimitExceeded = false;

  constructor(
    private maxBytes: number,
    private onLimitExceeded: () => void
  ) {}

  public processChunk(chunk: Buffer): void {
    if (this.outputLimitExceeded) return;

    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length >= 8) {
      const streamType = this.buffer.readUInt8(0);
      if (streamType !== 1 && streamType !== 2 && streamType !== 0) {
        // Non-standard frame; treat rest as stdout
        this.appendStdout(this.buffer);
        this.buffer = Buffer.alloc(0);
        break;
      }

      const payloadLength = this.buffer.readUInt32BE(4);
      if (this.buffer.length < 8 + payloadLength) {
        // Incomplete frame, wait for more data
        break;
      }

      const payload = this.buffer.subarray(8, 8 + payloadLength);
      this.buffer = this.buffer.subarray(8 + payloadLength);

      if (streamType === 2) {
        this.appendStderr(payload);
      } else {
        this.appendStdout(payload);
      }

      if (this.outputLimitExceeded) {
        break;
      }
    }
  }

  private appendStdout(payload: Buffer): void {
    this.stdoutBytes += payload.length;
    if (this.stdoutBytes > this.maxBytes) {
      this.outputLimitExceeded = true;
      this.onLimitExceeded();
      return;
    }
    this.stdoutChunks.push(payload);
  }

  private appendStderr(payload: Buffer): void {
    this.stderrBytes += payload.length;
    if (this.stderrBytes > this.maxBytes) {
      this.outputLimitExceeded = true;
      this.onLimitExceeded();
      return;
    }
    this.stderrChunks.push(payload);
  }

  public getStdout(): string {
    return Buffer.concat(this.stdoutChunks).toString('utf8');
  }

  public getStderr(): string {
    return Buffer.concat(this.stderrChunks).toString('utf8');
  }
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
  timeoutMs = 15000,
  options: RunnerOptions = {}
): Promise<{ success: true; binaryBuffer: Buffer } | { success: false; compileOutput: string }> {
  const runtime = await resolveSandboxRuntime(docker, options);
  let container: Docker.Container | null = null;
  let timeoutHandle: NodeJS.Timeout | null = null;

  try {
    container = (await docker.createContainer({
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
        ReadonlyRootfs: false,
        Runtime: runtime,
      },
    })) as Docker.Container;

    const archive = await createTarArchive([
      { name: 'solution.cpp', content: sourceCode, mode: 0o644 },
    ]);
    await container.putArchive(archive, { path: '/sandbox/workspace' });

    let timedOut = false;
    timeoutHandle = setTimeout(async () => {
      timedOut = true;
      try {
        if (container) await container.kill({ signal: 'SIGKILL' });
      } catch {
        // Ignored
      }
    }, timeoutMs);

    await container.start();
    const waitResult = await container.wait();

    const logBuffer = (await container.logs({
      stdout: true,
      stderr: true,
      follow: false,
    })) as unknown as Buffer;

    // Simple collector for compiler output
    const collector = new StreamOutputCollector(128 * 1024, () => {});
    collector.processChunk(logBuffer);
    const compileOutput = (collector.getStderr() + (collector.getStdout() ? `\n${collector.getStdout()}` : '')).trim();

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
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
    if (container) {
      try {
        await container.remove({ force: true });
      } catch {
        // Ignored
      }
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
  limits: ExecutionLimits,
  options: RunnerOptions = {}
): Promise<SingleTestResult> {
  const runtime = await resolveSandboxRuntime(docker, options);
  const maxOutputBytes = limits.maxOutputBytes || options.maxOutputBytes || DEFAULT_MAX_OUTPUT_BYTES;

  let container: Docker.Container | null = null;
  let timeoutHandle: NodeJS.Timeout | null = null;

  try {
    // We execute the binary and capture measured peak memory from cgroup v2 into .mem_usage
    const execScript =
      './solution < input.txt; EXIT=$?; ' +
      '(cat /sys/fs/cgroup/memory.peak 2>/dev/null || cat /sys/fs/cgroup/memory.current 2>/dev/null || echo 0) > /sandbox/workspace/.mem_usage; ' +
      'exit $EXIT';

    container = (await docker.createContainer({
      Image: RUNNER_IMAGE,
      Cmd: ['/bin/sh', '-c', execScript],
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
        ReadonlyRootfs: false,
        Tmpfs: {
          '/tmp': 'rw,noexec,nosuid,size=16m',
        },
        Runtime: runtime,
      },
    })) as Docker.Container;

    const archive = await createTarArchive([
      { name: 'solution', content: binaryBuffer, mode: 0o755 },
      { name: 'input.txt', content: testCase.input, mode: 0o644 },
    ]);
    await container.putArchive(archive, { path: '/sandbox/workspace' });

    // Attach stream to enforce real-time output cap and terminate workloads that exceed it
    const attachStream = (await container.attach({
      stream: true,
      stdout: true,
      stderr: true,
    })) as NodeJS.ReadableStream;

    const collector = new StreamOutputCollector(maxOutputBytes, async () => {
      // Workload exceeded output limit: immediately terminate
      try {
        if (container) await container.kill({ signal: 'SIGKILL' });
      } catch {
        // Ignored
      }
    });

    attachStream.on('data', (chunk: Buffer) => {
      collector.processChunk(chunk);
    });

    const wallClockLimitMs = Math.max(1500, Math.floor(limits.timeLimitMs * 1.5));
    let timedOut = false;

    timeoutHandle = setTimeout(async () => {
      timedOut = true;
      try {
        if (container) await container.kill({ signal: 'SIGKILL' });
      } catch {
        // Ignored
      }
    }, wallClockLimitMs);

    const startTime = performance.now();
    await container.start();
    const waitResult = await container.wait();
    const elapsedMs = Math.round(performance.now() - startTime);

    const inspect = await container.inspect();

    // Retrieve measured memory usage from cgroup v2
    let measuredMemoryKb = 0;
    if (inspect.State.OOMKilled) {
      measuredMemoryKb = limits.memoryLimitKb;
    } else {
      try {
        const memTar = (await container.getArchive({
          path: '/sandbox/workspace/.mem_usage',
        })) as NodeJS.ReadableStream;

        const chunks: Buffer[] = [];
        for await (const chunk of memTar) {
          chunks.push(chunk as Buffer);
        }
        const file = await extractFileFromTar(Buffer.concat(chunks), '.mem_usage');
        if (file) {
          const bytes = parseInt(file.toString('utf8').trim(), 10);
          if (!isNaN(bytes) && bytes > 0) {
            measuredMemoryKb = Math.round(bytes / 1024);
          }
        }
      } catch {
        // Fallback: 0 if not recorded
      }
    }

    const stdout = collector.getStdout();
    const stderr = collector.getStderr();

    let verdict: Verdict;
    let errorOutput = stderr;

    if (collector.outputLimitExceeded) {
      verdict = 'WRONG_ANSWER';
      errorOutput = 'Output Limit Exceeded';
    } else if (inspect.State.OOMKilled) {
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
      memoryKb: measuredMemoryKb, // Actual measured usage from cgroup
      actualOutput: stdout,
      errorOutput: errorOutput || undefined,
    };
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
    if (container) {
      try {
        await container.remove({ force: true });
      } catch {
        // Ignored
      }
    }
  }
}

/**
 * End-to-end execution of a C++ submission across all test cases.
 */
export async function runCppSubmission(
  sourceCode: string,
  testCases: TestCase[],
  limits: ExecutionLimits,
  options: RunnerOptions = {}
): Promise<ExecutionSummary> {
  const docker = getDockerClient();

  // 1. Compile
  const compileResult = await compileCpp(docker, sourceCode, 15000, options);
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
    const res = await executeTestCase(docker, compileResult.binaryBuffer, tc, limits, options);
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
