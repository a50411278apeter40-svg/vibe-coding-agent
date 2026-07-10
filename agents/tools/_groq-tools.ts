// OpenAI-compatible tool (function-calling) definitions for the Groq-driven
// coding agent. Unlike the old Claude Agent SDK tools (`_project-tools.ts`),
// these are plain JSON-schema function specs + a single executor — there is
// no MCP server involved, because Groq's API only understands the standard
// OpenAI `tools` / `tool_calls` format. Every tool operates directly on
// `context.sandbox`, the same EdgeOne-provisioned sandbox the old Claude path
// used, so no separate sandbox provider was needed after all.
import {
  ensureProjectScaffold,
  readFileFromSandbox,
  resolvePublicLinks,
  runSandboxCommand,
  startPreviewServer,
  assertPreviewServerReady,
  readPackageMetadata,
  upsertProjectEnvValue,
  listProjectEnvKeys,
  getProjectEnvValue,
  readAllProjectEnvValues,
} from '../_project';
import { createGithubRepoAndPush, deployToRenderService } from '../_render';
import type { ProjectFileInput, ProjectState, ScaffoldLog } from '../_types';
import { getBlockedProjectWriteReason, normalizeRelPath } from '../utils/_paths';
import { stringifyToolResult } from '../utils/_text';
import type { GroqToolSpec, GroqToolExecResult } from './_groq-tools-shared';
import { BROWSER_TOOLS, BROWSER_TOOL_NAMES, executeBrowserTool } from './_browserTools';
import { UTILITY_TOOLS, UTILITY_TOOL_NAMES, executeUtilityTool } from './_utilityTools';

export type { GroqToolSpec, GroqToolExecResult } from './_groq-tools-shared';

// The full tool catalog. Deliberately broader than the old Claude tool set —
// this adds run_command, read_project_file, list_project_directory,
// delete_project_path, and install_packages so the agent can inspect/modify
// the sandbox as freely as a real terminal, not just via batch file writes.
export const GROQ_TOOLS: GroqToolSpec[] = [
  {
    type: 'function',
    function: {
      name: 'ensure_project_scaffold',
      description: 'Prepare or reuse the project workspace in the sandbox before any project file reads or writes. Must be called first for any new build.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_project_files',
      description: 'Write one or more complete project files under the project directory. Paths must be relative. Use for creating or fully replacing source/config files.',
      parameters: {
        type: 'object',
        properties: {
          files: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string', description: 'Relative file path under the project directory.' },
                content: { type: 'string', description: 'Complete UTF-8 file contents.' },
              },
              required: ['path', 'content'],
            },
          },
        },
        required: ['files'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_project_file',
      description: 'Read the text content of a single existing project file (relative path). Use before editing a file you have not already written this turn.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path under the project directory.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_project_directory',
      description: 'List files and folders under a directory inside the project (relative path, "." for project root).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative directory path under the project directory. Defaults to "." (project root).' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_project_path',
      description: 'Delete a file or directory (recursively) inside the project directory. Use sparingly and only on paths you created or the user asked to remove.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file or directory path under the project directory.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run an arbitrary shell command inside the project directory in the sandbox (e.g. custom scripts, git, file inspection). For installing dependencies prefer install_packages.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute, run with cwd set to the project directory.' },
          timeout: { type: 'number', description: 'Optional timeout in seconds (default 120).' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'install_packages',
      description: 'Install one or more dependencies for the project using the correct package manager (npm for Node/frontend projects by default, pip for Python projects).',
      parameters: {
        type: 'object',
        properties: {
          packages: {
            type: 'array',
            items: { type: 'string' },
            description: 'Package names to install, e.g. ["axios", "zod"].',
          },
          manager: {
            type: 'string',
            enum: ['npm', 'pnpm', 'yarn', 'pip'],
            description: 'Package manager to use. Defaults to npm.',
          },
          dev: { type: 'boolean', description: 'Install as a dev dependency (npm/pnpm/yarn only).' },
        },
        required: ['packages'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'publish_preview',
      description: 'Publish the project preview. Starts/refreshes the internal dev server, waits until it is ready, and returns the public preview URL. Call this after writing files and installing dependencies.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_uploaded_files',
      description: 'List every file the user has attached/uploaded so far in this conversation, with paths relative to the project directory.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Fetch the text content of a URL (documentation, API references, JSON endpoints). Returns status, content-type, and up to 20,000 characters of body text.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Absolute http(s) URL to fetch.' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_api_key',
      description: 'Securely save an API key / secret the user gave you (e.g. RENDER_API_KEY, GITHUB_TOKEN, a database URL, a third-party API key the app itself needs) into the project\'s own .env file inside the sandbox. It persists across sandbox restarts and is never committed to git or shown back in chat. Always use this instead of writing secrets into source files.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Env var name, letters/numbers/underscore only, e.g. RENDER_API_KEY.' },
          value: { type: 'string', description: 'The secret value.' },
        },
        required: ['name', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_saved_api_keys',
      description: 'List the names (not values) of API keys/secrets already saved for this project via save_api_key, so you know what is already configured before asking the user again.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'deploy_to_render',
      description: 'Deploy the current project to Render.com as a live web service. Requires RENDER_API_KEY and GITHUB_TOKEN (a GitHub personal access token with "repo" scope) to already be saved via save_api_key -- if either is missing, this returns an error telling you which one to ask the user for. Pushes the project to a new (or existing) GitHub repo under that token\'s account, then creates/updates a Render web service pointing at it, forwarding any other saved project secrets as its environment variables.',
      parameters: {
        type: 'object',
        properties: {
          serviceName: { type: 'string', description: 'Desired service/repo name. Defaults to a name derived from the project.' },
          buildCommand: { type: 'string', description: 'Defaults to an auto-detected "npm install [&& npm run build]".' },
          startCommand: { type: 'string', description: 'Defaults to an auto-detected "npm start"/"npm run dev"/backend entry point.' },
        },
      },
    },
  },
  ...BROWSER_TOOLS,
  ...UTILITY_TOOLS,
];

// Unlimited: rawText.slice(0, Infinity) returns the full string, so
// web_fetch results are no longer clipped before being handed back to Gemma.
const WEB_FETCH_MAX_CHARS = Infinity;
const WEB_FETCH_TIMEOUT_MS = 15000;

type ExecutorDeps = {
  context: any;
  state: ProjectState;
  onScaffoldLog?: (log: ScaffoldLog) => void;
  onScaffoldResult?: (result: { created: boolean }) => void;
  onWriteResult?: (result: { written: string[] }) => void | Promise<void>;
  onPreviewResult?: (result: { url?: string; sandboxDebugUrl?: string }) => void;
};

export async function executeGroqTool(
  name: string,
  rawArgs: string,
  deps: ExecutorDeps,
): Promise<GroqToolExecResult> {
  let args: any = {};
  try {
    args = rawArgs ? JSON.parse(rawArgs) : {};
  } catch {
    args = {};
  }

  if ((UTILITY_TOOL_NAMES as readonly string[]).includes(name)) {
    return executeUtilityTool(name, args);
  }
  if ((BROWSER_TOOL_NAMES as readonly string[]).includes(name)) {
    return executeBrowserTool(name, args, deps.state.sessionDir);
  }

  try {
    switch (name) {
      case 'ensure_project_scaffold': {
        const created = await ensureProjectScaffold(deps.context, deps.state, deps.onScaffoldLog);
        deps.state.created = true;
        deps.onScaffoldResult?.({ created });
        return { ok: true, text: stringifyToolResult({ created, appDir: deps.state.appDir }) };
      }

      case 'write_project_files': {
        const files = normalizeProjectFilesInput(args?.files);
        if (files.length === 0) {
          throw new Error('Missing files. Call write_project_files with {"files":[{"path":"src/App.tsx","content":"..."}]}.');
        }
        const written: string[] = [];
        for (const file of files) {
          const relPath = normalizeRelPath(file.path);
          if (!relPath) throw new Error(`Invalid file path: ${file.path}`);
          const blockedReason = getBlockedProjectWriteReason(relPath);
          if (blockedReason) throw new Error(`Refusing to write ${relPath}: ${blockedReason}`);
          const parent = relPath.split('/').slice(0, -1).join('/');
          if (parent) {
            await deps.context.sandbox.files.makeDir(`${deps.state.appDir}/${parent}`);
          }
          await deps.context.sandbox.files.write(`${deps.state.appDir}/${relPath}`, file.content);
          written.push(relPath);
        }
        await deps.onWriteResult?.({ written });
        return { ok: true, text: stringifyToolResult({ written }) };
      }

      case 'read_project_file': {
        const relPath = normalizeRelPath(String(args?.path || ''));
        if (!relPath) throw new Error('Missing path.');
        const result = await readFileFromSandbox(deps.context, deps.state, relPath);
        if (!result.ok) throw new Error(result.error || 'Read failed.');
        return { ok: true, text: stringifyToolResult(result) };
      }

      case 'list_project_directory': {
        const relPath = normalizeRelPath(String(args?.path || '.')) || '.';
        const result = await runSandboxCommand(
          deps.context,
          `find '${relPath}' -mindepth 1 -maxdepth 2 -not -path '*/node_modules/*' -not -path '*/.next/*' -not -path '*/.git/*' | sort`,
          { cwd: deps.state.appDir, timeout: 20 },
        );
        if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || 'List failed.');
        const entries = result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
        return { ok: true, text: stringifyToolResult({ entries }) };
      }

      case 'delete_project_path': {
        const relPath = normalizeRelPath(String(args?.path || ''));
        if (!relPath) throw new Error('Missing path.');
        const blockedReason = getBlockedProjectWriteReason(relPath);
        if (blockedReason) throw new Error(`Refusing to delete ${relPath}: ${blockedReason}`);
        const result = await runSandboxCommand(deps.context, `rm -rf -- '${relPath}'`, {
          cwd: deps.state.appDir,
          timeout: 20,
        });
        if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || 'Delete failed.');
        return { ok: true, text: stringifyToolResult({ deleted: relPath }) };
      }

      case 'run_command': {
        const command = String(args?.command || '').trim();
        if (!command) throw new Error('Missing command.');
        const timeout = typeof args?.timeout === 'number' ? args.timeout : 120;
        const result = await runSandboxCommand(deps.context, command, { cwd: deps.state.appDir, timeout });
        return {
          ok: result.exitCode === 0,
          text: stringifyToolResult({ exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }),
        };
      }

      case 'install_packages': {
        const packages = Array.isArray(args?.packages) ? args.packages.map(String).filter(Boolean) : [];
        if (packages.length === 0) throw new Error('Missing packages.');
        const manager = typeof args?.manager === 'string' ? args.manager : 'npm';
        const dev = args?.dev === true;
        let command: string;
        if (manager === 'pip') {
          command = `python -m pip install ${packages.map(shellArg).join(' ')}`;
        } else if (manager === 'pnpm') {
          command = `pnpm add ${dev ? '-D ' : ''}${packages.map(shellArg).join(' ')}`;
        } else if (manager === 'yarn') {
          command = `yarn add ${dev ? '-D ' : ''}${packages.map(shellArg).join(' ')}`;
        } else {
          command = `npm install ${dev ? '--save-dev ' : ''}${packages.map(shellArg).join(' ')}`;
        }
        const result = await runSandboxCommand(deps.context, command, { cwd: deps.state.appDir, timeout: 300 });
        return {
          ok: result.exitCode === 0,
          text: stringifyToolResult({ exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }),
        };
      }

      case 'publish_preview': {
        if (!deps.state.created) {
          throw new Error('There is no previewable project yet. Please describe the page or feature you want to build first.');
        }
        const appDirExists = await deps.context.sandbox.files.exists(deps.state.appDir);
        if (!appDirExists) throw new Error(`Project workspace does not exist: ${deps.state.appDir}`);
        const server = await startPreviewServer(deps.context, deps.state);
        await assertPreviewServerReady(deps.context, server.readyPath);
        const links = await resolvePublicLinks(deps.context);
        deps.state.previewUrl = links.previewUrl;
        deps.state.sandboxDebugUrl = links.sandboxDebugUrl;
        deps.onPreviewResult?.({ url: deps.state.previewUrl, sandboxDebugUrl: deps.state.sandboxDebugUrl });
        return { ok: true, text: stringifyToolResult({ url: deps.state.previewUrl, sandboxDebugUrl: deps.state.sandboxDebugUrl }) };
      }

      case 'list_uploaded_files': {
        const uploadsDir = `${deps.state.appDir}/uploads`;
        const exists = await deps.context.sandbox.files.exists(uploadsDir);
        if (!exists) return { ok: true, text: stringifyToolResult({ files: [] }) };
        const result = await runSandboxCommand(deps.context, 'find . -type f', { cwd: uploadsDir, timeout: 30 });
        if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || 'Failed to list uploaded files.');
        const files = result.stdout
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => `uploads/${line.replace(/^\.\//, '')}`);
        return { ok: true, text: stringifyToolResult({ files }) };
      }

      case 'web_fetch': {
        const url = typeof args?.url === 'string' ? args.url.trim() : '';
        if (!/^https?:\/\//i.test(url)) throw new Error('Invalid url. Provide an absolute http:// or https:// URL.');
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), WEB_FETCH_TIMEOUT_MS);
        let response: Response;
        try {
          response = await fetch(url, { signal: controller.signal, headers: { 'user-agent': 'PIXAL2.0-web-dev-agent/1.0' } });
        } finally {
          clearTimeout(timeout);
        }
        const contentType = response.headers.get('content-type') || '';
        const rawText = await response.text();
        const truncated = rawText.length > WEB_FETCH_MAX_CHARS;
        const text = truncated ? rawText.slice(0, WEB_FETCH_MAX_CHARS) : rawText;
        return { ok: true, text: stringifyToolResult({ status: response.status, ok: response.ok, contentType, truncated, body: text }) };
      }

      case 'save_api_key': {
        const key = String(args?.name || '').trim();
        const value = String(args?.value ?? '');
        if (!key) throw new Error('Missing name.');
        if (!value) throw new Error('Missing value.');
        await upsertProjectEnvValue(deps.context, deps.state, key, value);
        return { ok: true, text: stringifyToolResult({ saved: true, key }) };
      }

      case 'list_saved_api_keys': {
        const keys = await listProjectEnvKeys(deps.context, deps.state);
        return { ok: true, text: stringifyToolResult({ keys }) };
      }

      case 'deploy_to_render': {
        if (!deps.state.created) {
          throw new Error('There is no project to deploy yet. Build something first.');
        }
        const renderApiKey = await getProjectEnvValue(deps.context, deps.state, 'RENDER_API_KEY');
        const githubToken = await getProjectEnvValue(deps.context, deps.state, 'GITHUB_TOKEN');
        const missing: string[] = [];
        if (!renderApiKey) missing.push('RENDER_API_KEY');
        if (!githubToken) missing.push('GITHUB_TOKEN (a GitHub personal access token with "repo" scope)');
        if (missing.length > 0) {
          throw new Error(`Cannot deploy yet -- ask the user for the following and save each with save_api_key first: ${missing.join(', ')}.`);
        }

        const serviceName = typeof args?.serviceName === 'string' && args.serviceName.trim()
          ? args.serviceName.trim()
          : `pixal-${deps.state.sessionDir.split('/').pop() || 'project'}`;

        const push = await createGithubRepoAndPush(deps.context, deps.state, githubToken!, serviceName);

        const metadata: { scripts?: Record<string, string>; deps?: Record<string, string> } = await readPackageMetadata(deps.context, deps.state).catch(() => ({ scripts: {}, deps: {} }));
        const scripts = metadata.scripts || {};
        const buildCommand = typeof args?.buildCommand === 'string' && args.buildCommand.trim()
          ? args.buildCommand.trim()
          : (scripts.build ? 'npm install && npm run build' : 'npm install');
        const startCommand = typeof args?.startCommand === 'string' && args.startCommand.trim()
          ? args.startCommand.trim()
          : (scripts.start ? 'npm start' : (scripts.dev ? 'npm run dev' : 'node server/index.js'));

        const allSecrets = await readAllProjectEnvValues(deps.context, deps.state);
        const envVars = Object.entries(allSecrets)
          .filter(([k]) => k !== 'RENDER_API_KEY' && k !== 'GITHUB_TOKEN')
          .map(([key, value]) => ({ key, value }));

        const deployResult = await deployToRenderService(renderApiKey!, {
          serviceName,
          repoUrl: push.htmlUrl,
          branch: push.defaultBranch,
          buildCommand,
          startCommand,
          envVars,
        });

        return {
          ok: true,
          text: stringifyToolResult({
            githubRepo: push.htmlUrl,
            renderDashboard: deployResult.dashboardUrl,
            liveUrl: deployResult.liveUrl,
            note: 'The live URL becomes reachable after Render finishes its first build, usually a few minutes.',
          }),
        };
      }

      default:
        return { ok: false, text: `Unknown tool: ${name}` };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, text: message };
  }
}

function shellArg(value: string): string {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function normalizeProjectFilesInput(files: unknown): ProjectFileInput[] {
  if (Array.isArray(files)) {
    return files.filter((f) => f && typeof f.path === 'string' && typeof f.content === 'string');
  }
  return [];
}
