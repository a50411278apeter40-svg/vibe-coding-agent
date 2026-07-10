// Render.com deployment: pushes the current sandbox project to a GitHub repo
// and creates/updates a Render web service pointing at it. Render's API only
// deploys from a git repository (there is no "upload a zip" endpoint), so a
// GitHub personal access token is required in addition to the Render API key
// -- both are provided by the user via the save_api_key tool and read back
// out of the project's own .env (see _project.ts's project-env helpers).
import { runSandboxCommand } from './_project';
import type { ProjectState } from './_types';

const GITHUB_API_BASE = 'https://api.github.com';
const RENDER_API_BASE = 'https://api.render.com/v1';

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 20000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function slugifyRepoName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);
  return slug || `pixal-project-${Date.now()}`;
}

export type GithubPushResult = {
  owner: string;
  repo: string;
  htmlUrl: string;
  cloneUrl: string;
  defaultBranch: string;
};

// Creates (or reuses) a GitHub repo under the token's own account, then git
// pushes the current project directory to it as the sole/latest commit.
// .env is deliberately excluded from what gets committed -- secrets go to
// Render via its own envVars field, never into the generated app's git
// history.
export async function createGithubRepoAndPush(
  context: any,
  state: ProjectState,
  githubToken: string,
  desiredRepoName: string,
): Promise<GithubPushResult> {
  const userRes = await fetchWithTimeout(`${GITHUB_API_BASE}/user`, {
    headers: { authorization: `Bearer ${githubToken}`, accept: 'application/vnd.github+json' },
  });
  if (!userRes.ok) {
    throw new Error(`GitHub token check failed (${userRes.status}). Make sure GITHUB_TOKEN is a valid personal access token with "repo" scope.`);
  }
  const user = await userRes.json();
  const owner = user.login as string;
  const repoName = slugifyRepoName(desiredRepoName);

  let repo: any;
  const createRes = await fetchWithTimeout(`${GITHUB_API_BASE}/user/repos`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${githubToken}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ name: repoName, private: false, auto_init: false }),
  });
  if (createRes.status === 201) {
    repo = await createRes.json();
  } else if (createRes.status === 422) {
    // Repo already exists under this account -- reuse it (redeploy flow).
    const existingRes = await fetchWithTimeout(`${GITHUB_API_BASE}/repos/${owner}/${repoName}`, {
      headers: { authorization: `Bearer ${githubToken}`, accept: 'application/vnd.github+json' },
    });
    if (!existingRes.ok) throw new Error(`Repo "${repoName}" already exists but could not be read back (${existingRes.status}).`);
    repo = await existingRes.json();
  } else {
    const errText = await createRes.text().catch(() => '');
    throw new Error(`Failed to create GitHub repo (${createRes.status}): ${errText}`);
  }

  const defaultBranch = repo.default_branch || 'main';
  const remoteUrl = `https://x-access-token:${githubToken}@github.com/${owner}/${repoName}.git`;

  // Ensure secrets/build artifacts never get committed into the deploy repo.
  const gitignoreEnsure = [
    'if [ -f .gitignore ]; then',
    '  touch .gitignore;',
    'else',
    '  : > .gitignore;',
    'fi;',
    'for entry in .env node_modules dist build .next .cache; do',
    '  grep -qxF "$entry" .gitignore || echo "$entry" >> .gitignore;',
    'done',
  ].join(' ');
  await runSandboxCommand(context, gitignoreEnsure, { cwd: state.appDir, timeout: 15 });

  const pushScript = [
    'set -e',
    'if [ ! -d .git ]; then git init -q -b main; fi',
    'git checkout -q -B main',
    'git config user.email "pixal2@deploy.local"',
    'git config user.name "PIXAL2.0"',
    'git add -A',
    'git commit -q -m "Deploy via PIXAL2.0" --allow-empty',
    `git remote remove origin 2>/dev/null || true`,
    `git remote add origin ${JSON.stringify(remoteUrl)}`,
    'git push -q -f origin main:main',
  ].join(' && ');

  const pushResult = await runSandboxCommand(context, pushScript, { cwd: state.appDir, timeout: 120 });
  if (pushResult.exitCode !== 0) {
    throw new Error(`git push to GitHub failed: ${pushResult.stderr || pushResult.stdout || 'unknown error'}`);
  }

  return {
    owner,
    repo: repoName,
    htmlUrl: repo.html_url || `https://github.com/${owner}/${repoName}`,
    cloneUrl: repo.clone_url || `https://github.com/${owner}/${repoName}.git`,
    defaultBranch: 'main',
  };
}

async function fetchRenderOwnerId(renderApiKey: string): Promise<string> {
  const res = await fetchWithTimeout(`${RENDER_API_BASE}/owners`, {
    headers: { authorization: `Bearer ${renderApiKey}`, accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`Render API token check failed (${res.status}). Make sure RENDER_API_KEY is valid.`);
  }
  const owners = await res.json();
  const first = Array.isArray(owners) ? owners[0]?.owner : undefined;
  if (!first?.id) throw new Error('Could not determine a Render workspace (owner) for this API key.');
  return first.id as string;
}

export type RenderDeployResult = {
  serviceId: string;
  dashboardUrl: string;
  liveUrl: string;
  slug: string;
  deployId?: string;
};

export async function deployToRenderService(
  renderApiKey: string,
  opts: {
    serviceName: string;
    repoUrl: string;
    branch: string;
    buildCommand: string;
    startCommand: string;
    envVars: { key: string; value: string }[];
  },
): Promise<RenderDeployResult> {
  const ownerId = await fetchRenderOwnerId(renderApiKey);

  const body = {
    type: 'web_service',
    name: slugifyRepoName(opts.serviceName),
    ownerId,
    repo: opts.repoUrl,
    branch: opts.branch,
    autoDeploy: 'yes',
    envVars: opts.envVars,
    serviceDetails: {
      runtime: 'node',
      plan: 'free',
      region: 'oregon',
      envSpecificDetails: {
        buildCommand: opts.buildCommand,
        startCommand: opts.startCommand,
      },
    },
  };

  const res = await fetchWithTimeout(`${RENDER_API_BASE}/services`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${renderApiKey}`,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (res.status !== 201) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Render service creation failed (${res.status}): ${errText}`);
  }

  const json = await res.json();
  const service = json.service || json;
  const slug = service.slug || slugifyRepoName(opts.serviceName);
  return {
    serviceId: service.id,
    dashboardUrl: service.dashboardUrl || `https://dashboard.render.com/web/${service.id}`,
    liveUrl: `https://${slug}.onrender.com`,
    slug,
    deployId: json.deployId,
  };
}
