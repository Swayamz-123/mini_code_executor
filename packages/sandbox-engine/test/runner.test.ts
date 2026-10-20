import { describe, expect, it } from 'vitest';
import type { ExecutionLimits, TestCase } from '@codeforge/shared-types';
import { getDockerClient, runCppSubmission, StrictRuntimeError } from '../src/index.js';

describe('Milestone 1 Hardened Execution Engine Tests', () => {
  const defaultLimits: ExecutionLimits = {
    timeLimitMs: 1000,
    memoryLimitKb: 262144, // 256 MB
    maxOutputBytes: 64 * 1024,
  };

  const sampleTestCases: TestCase[] = [
    {
      id: 'tc-1',
      problemId: 'prob-1',
      input: '5 7\n',
      expectedOutput: '12\n',
      isPublic: true,
    },
    {
      id: 'tc-2',
      problemId: 'prob-1',
      input: '100 250\n',
      expectedOutput: '350\n',
      isPublic: false,
    },
  ];

  it('correctly accepts a valid C++ solution and measures real memory usage', async () => {
    const validCpp = `
      #include <iostream>
      int main() {
        long long a, b;
        if (std::cin >> a >> b) {
          std::cout << (a + b) << "\\n";
        }
        return 0;
      }
    `;

    const summary = await runCppSubmission(validCpp, sampleTestCases, defaultLimits);

    expect(summary.verdict).toBe('ACCEPTED');
    expect(summary.testResults).toHaveLength(2);
    expect(summary.testResults[0].verdict).toBe('ACCEPTED');
    expect(summary.testResults[0].actualOutput?.trim()).toBe('12');
    expect(summary.testResults[1].actualOutput?.trim()).toBe('350');

    // Verify memory accounting: must be measured memory (> 0 and < configured limit), not just hardcoded limit
    expect(summary.peakMemoryKb).toBeGreaterThan(0);
    expect(summary.peakMemoryKb).toBeLessThan(defaultLimits.memoryLimitKb);
  });

  it('correctly flags output mismatch as WRONG_ANSWER', async () => {
    const wrongCpp = `
      #include <iostream>
      int main() {
        long long a, b;
        if (std::cin >> a >> b) {
          std::cout << (a - b) << "\\n";
        }
        return 0;
      }
    `;

    const summary = await runCppSubmission(wrongCpp, sampleTestCases, defaultLimits);

    expect(summary.verdict).toBe('WRONG_ANSWER');
    expect(summary.testResults[0].verdict).toBe('WRONG_ANSWER');
    expect(summary.testResults[0].actualOutput?.trim()).toBe('-2');
  });

  it('handles syntax errors with COMPILE_ERROR and preserves compiler diagnostic', async () => {
    const brokenCpp = `
      #include <iostream>
      int main() {
        undefined_variable = 42;
        return 0;
      }
    `;

    const summary = await runCppSubmission(brokenCpp, sampleTestCases, defaultLimits);

    expect(summary.verdict).toBe('COMPILE_ERROR');
    expect(summary.compileOutput).toBeDefined();
    expect(summary.compileOutput).toContain('undefined_variable');
  });

  it('enforces wall-clock timeout on infinite loops with TIME_LIMIT_EXCEEDED and cleans up containers', async () => {
    const infiniteLoopCpp = `
      #include <iostream>
      int main() {
        volatile int x = 0;
        while (true) {
          x++;
        }
        return 0;
      }
    `;

    const strictLimits: ExecutionLimits = {
      timeLimitMs: 500, // 500ms limit
      memoryLimitKb: 262144,
    };

    const summary = await runCppSubmission(infiniteLoopCpp, sampleTestCases.slice(0, 1), strictLimits);

    expect(summary.verdict).toBe('TIME_LIMIT_EXCEEDED');
    expect(summary.testResults[0].verdict).toBe('TIME_LIMIT_EXCEEDED');

    // Verify container cleanup: ensure no orphaned running container remains
    const docker = getDockerClient();
    const running = await docker.listContainers({
      filters: { ancestor: ['codeforge-runner-cpp:latest'], status: ['running'] },
    });
    expect(running).toHaveLength(0);
  });

  it('handles runtime crashes (e.g. segmentation fault) with RUNTIME_ERROR', async () => {
    const segfaultCpp = `
      #include <iostream>
      int main() {
        int* p = nullptr;
        *p = 42; // Null pointer dereference
        return 0;
      }
    `;

    const summary = await runCppSubmission(segfaultCpp, sampleTestCases.slice(0, 1), defaultLimits);

    expect(summary.verdict).toBe('RUNTIME_ERROR');
    expect(summary.testResults[0].verdict).toBe('RUNTIME_ERROR');
  });

  it('enforces real-time output cap and terminates excessive output workloads', async () => {
    const infiniteOutputCpp = `
      #include <iostream>
      int main() {
        while (true) {
          std::cout << "FLOODING_STDOUT_LINE_WITH_EXCESSIVE_DATA_1234567890\\n";
        }
        return 0;
      }
    `;

    const lowOutputLimits: ExecutionLimits = {
      timeLimitMs: 3000,
      memoryLimitKb: 262144,
      maxOutputBytes: 2048, // Low 2 KB cap
    };

    const summary = await runCppSubmission(infiniteOutputCpp, sampleTestCases.slice(0, 1), lowOutputLimits);

    expect(summary.verdict).toBe('WRONG_ANSWER');
    expect(summary.testResults[0].errorOutput).toContain('Output Limit Exceeded');
  });

  it('enforces memory limit on excessive allocations with MEMORY_LIMIT_EXCEEDED', async () => {
    // Attempt to allocate 64 MB inside a 16 MB limit container
    const memoryBombCpp = `
      #include <iostream>
      #include <vector>
      int main() {
        std::vector<char*> ptrs;
        for (int i = 0; i < 64; i++) {
          char* block = new char[1024 * 1024]; // 1MB
          for (int j = 0; j < 1024 * 1024; j += 4096) {
            block[j] = 1; // Touch page to force kernel memory fault
          }
          ptrs.push_back(block);
        }
        std::cout << "Allocated " << ptrs.size() << " MB\\n";
        return 0;
      }
    `;

    const tightMemoryLimits: ExecutionLimits = {
      timeLimitMs: 2000,
      memoryLimitKb: 16384, // 16 MB limit
    };

    const summary = await runCppSubmission(memoryBombCpp, sampleTestCases.slice(0, 1), tightMemoryLimits);

    expect(summary.verdict).toBe('MEMORY_LIMIT_EXCEEDED');
    expect(summary.testResults[0].verdict).toBe('MEMORY_LIMIT_EXCEEDED');
  });

  it('strict sandbox mode refuses execution when required runtime is unavailable', async () => {
    const validCpp = `
      #include <iostream>
      int main() {
        std::cout << 42 << std::endl;
        return 0;
      }
    `;

    await expect(
      runCppSubmission(
        validCpp,
        sampleTestCases.slice(0, 1),
        defaultLimits,
        {
          strictRuntime: true,
          requestedRuntime: 'runsc',
        }
      )
    ).rejects.toThrow(StrictRuntimeError);
  });
});
