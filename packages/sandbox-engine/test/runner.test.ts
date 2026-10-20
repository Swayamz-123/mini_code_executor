import { describe, expect, it } from 'vitest';
import type { ExecutionLimits, TestCase } from '@codeforge/shared-types';
import { runCppSubmission } from '../src/index.js';

describe('Milestone 1 - Vertical Slice Execution Pipeline', () => {
  const defaultLimits: ExecutionLimits = {
    timeLimitMs: 1000,
    memoryLimitKb: 262144, // 256 MB
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

  it('correctly compiles and accepts a valid C++ solution (ACCEPTED)', async () => {
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
    expect(summary.testResults[1].verdict).toBe('ACCEPTED');
    expect(summary.testResults[0].actualOutput.trim()).toBe('12');
    expect(summary.testResults[1].actualOutput.trim()).toBe('350');
  });

  it('correctly flags output mismatch as WRONG_ANSWER', async () => {
    const wrongCpp = `
      #include <iostream>
      int main() {
        long long a, b;
        if (std::cin >> a >> b) {
          std::cout << (a - b) << "\\n"; // Buggy subtraction
        }
        return 0;
      }
    `;

    const summary = await runCppSubmission(wrongCpp, sampleTestCases, defaultLimits);

    expect(summary.verdict).toBe('WRONG_ANSWER');
    expect(summary.testResults.length).toBeGreaterThanOrEqual(1);
    expect(summary.testResults[0].verdict).toBe('WRONG_ANSWER');
    expect(summary.testResults[0].actualOutput.trim()).toBe('-2');
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

  it('enforces wall-clock timeout on infinite loops with TIME_LIMIT_EXCEEDED', async () => {
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
      timeLimitMs: 500, // Short 500ms limit
      memoryLimitKb: 262144,
    };

    const summary = await runCppSubmission(infiniteLoopCpp, sampleTestCases.slice(0, 1), strictLimits);

    expect(summary.verdict).toBe('TIME_LIMIT_EXCEEDED');
    expect(summary.testResults[0].verdict).toBe('TIME_LIMIT_EXCEEDED');
  });

  it('handles runtime crashes (e.g. segmentation fault) with RUNTIME_ERROR', async () => {
    const segfaultCpp = `
      #include <iostream>
      int main() {
        int* p = nullptr;
        *p = 42; // Null pointer dereference -> SIGSEGV
        return 0;
      }
    `;

    const summary = await runCppSubmission(segfaultCpp, sampleTestCases.slice(0, 1), defaultLimits);

    expect(summary.verdict).toBe('RUNTIME_ERROR');
    expect(summary.testResults[0].verdict).toBe('RUNTIME_ERROR');
  });
});
