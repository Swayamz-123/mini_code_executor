export type Language = 'CPP' | 'PYTHON' | 'JAVA' | 'JAVASCRIPT';

export type Verdict =
  | 'ACCEPTED'
  | 'WRONG_ANSWER'
  | 'TIME_LIMIT_EXCEEDED'
  | 'MEMORY_LIMIT_EXCEEDED'
  | 'COMPILE_ERROR'
  | 'RUNTIME_ERROR'
  | 'SYSTEM_ERROR';

export type SubmissionStatus =
  | 'PENDING'
  | 'QUEUED'
  | 'CLAIMED'
  | 'COMPILING'
  | 'RUNNING'
  | 'FINALIZING'
  | 'COMPLETED'
  | 'FAILED';

export interface TestCase {
  id: string;
  problemId: string;
  input: string;
  expectedOutput: string;
  isPublic: boolean;
  orderIndex?: number;
}

export interface Problem {
  id: string;
  slug: string;
  title: string;
  description: string;
  timeLimitMs: number;
  memoryLimitKb: number;
}

export interface ExecutionLimits {
  timeLimitMs: number;
  memoryLimitKb: number;
  maxOutputBytes?: number;
}

export interface SingleTestResult {
  testCaseId?: string;
  verdict: Verdict;
  timeMs: number;
  memoryKb: number;
  actualOutput?: string;
  errorOutput?: string;
}

export interface ExecutionSummary {
  verdict: Verdict;
  compileOutput?: string;
  totalTimeMs: number;
  peakMemoryKb: number;
  testResults: SingleTestResult[];
}
