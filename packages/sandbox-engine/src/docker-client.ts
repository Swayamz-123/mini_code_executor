import Docker from 'dockerode';
import process from 'node:process';

let dockerInstance: Docker | null = null;
let cachedRuntime: string | undefined = undefined;

export class StrictRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StrictRuntimeError';
  }
}

export function getDockerClient(): Docker {
  if (!dockerInstance) {
    if (process.platform === 'win32') {
      dockerInstance = new Docker({
        socketPath: '//./pipe/dockerDesktopLinuxEngine',
      });
    } else {
      dockerInstance = new Docker();
    }
  }
  return dockerInstance;
}

export interface RuntimeResolutionOptions {
  strictRuntime?: boolean;
  requestedRuntime?: string;
}

/**
 * Resolves the sandbox runtime.
 * If strictRuntime is true and requested runtime is unavailable, throws StrictRuntimeError.
 * In development (strictRuntime=false), falls back to hardened 'runc' with explicit warning.
 */
export async function resolveSandboxRuntime(
  docker: Docker,
  options: RuntimeResolutionOptions = {}
): Promise<string | undefined> {
  const requestedRuntime =
    options.requestedRuntime || process.env.SANDBOX_RUNTIME || 'runsc';
  const isStrict =
    options.strictRuntime ?? (process.env.SANDBOX_STRICT_RUNTIME === 'true');

  try {
    const info = await docker.info();
    const availableRuntimes = Object.keys(info.Runtimes || {});

    if (availableRuntimes.includes(requestedRuntime)) {
      if (cachedRuntime !== requestedRuntime) {
        console.log(`[SANDBOX] Active execution runtime: ${requestedRuntime}`);
        cachedRuntime = requestedRuntime;
      }
      return requestedRuntime;
    }

    if (isStrict) {
      throw new StrictRuntimeError(
        `[SANDBOX_FATAL] Strict sandbox mode is enabled: requested runtime '${requestedRuntime}' ` +
        `is not configured in Docker daemon (available: [${availableRuntimes.join(', ')}]). ` +
        `Untrusted execution refused.`
      );
    }

    if (cachedRuntime !== '') {
      console.warn(
        `[SANDBOX_WARN] Requested runtime '${requestedRuntime}' is not configured in Docker daemon ` +
        `(available: [${availableRuntimes.join(', ')}]). ` +
        `Falling back to hardened 'runc' with dropped capabilities and cgroups v2 for development. ` +
        `Untrusted production execution requires '${requestedRuntime}'.`
      );
      cachedRuntime = '';
    }

    return undefined;
  } catch (err) {
    if (err instanceof StrictRuntimeError) {
      throw err;
    }
    if (isStrict) {
      throw new StrictRuntimeError(
        `[SANDBOX_FATAL] Strict sandbox mode failed to query Docker daemon runtimes: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
    console.warn(`[SANDBOX_WARN] Failed to query Docker runtimes, falling back to default:`, err);
    return undefined;
  }
}
