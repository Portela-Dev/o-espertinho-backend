import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyMainRelease } from '../scripts/ci/release-policy.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'espertinho-release-policy-')),
    work = join(root, 'work'),
    remote = join(root, 'remote.git');
  t.after(() => {
    if (
      dirname(resolve(root)) !== resolve(tmpdir()) ||
      !basename(root).startsWith('espertinho-release-policy-')
    )
      throw new Error('Pasta temporária inesperada.');
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(work);
  const git = (args) =>
    execFileSync('git', args, {
      cwd: work,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git(['init']);
  git(['config', 'user.name', 'Release policy test']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['config', 'tag.gpgsign', 'false']);
  git(['checkout', '-b', 'main']);
  const commit = () => {
    writeFileSync(
      join(work, 'fixture.txt'),
      String(Date.now()) + Math.random(),
    );
    git(['add', 'fixture.txt']);
    git(['commit', '-m', 'Fixture']);
    return git(['rev-parse', 'HEAD']);
  };
  const sha = commit();
  git(['init', '--bare', remote]);
  git(['remote', 'add', 'origin', remote]);
  git(['push', '-u', 'origin', 'main']);
  const context = (tag = 'v1.0.0', value = sha) => ({
    eventName: 'push',
    ref: 'refs/tags/' + tag,
    sha: value,
    event: {
      created: true,
      deleted: false,
      forced: false,
      ref: 'refs/tags/' + tag,
    },
  });
  return { root, work, git, sha, commit, context };
}

test('pushes em branches, PRs e disparos manuais nunca autorizam deploy', () => {
  for (const eventName of ['push', 'pull_request', 'workflow_dispatch'])
    for (const ref of [
      'refs/heads/main',
      'refs/heads/develop',
      'refs/heads/staging',
      'refs/heads/feature/test',
      'refs/tags/v1.0.0',
    ]) {
      if (eventName === 'push' && ref.startsWith('refs/tags/')) continue;
      assert.equal(
        verifyMainRelease(
          { eventName, ref, sha: 'a'.repeat(40), event: {} },
          () => assert.fail('Não deveria consultar Git.'),
        ),
        false,
      );
    }
  assert.equal(
    verifyMainRelease(
      { eventName: 'push', ref: 'refs/tags/staging-v1.0.0', event: {} },
      () => assert.fail(),
    ),
    false,
  );
});

test('tags leves e anotadas são aceitas somente no commit atual de main', (t) => {
  const f = fixture(t);
  f.git(['tag', 'v1.0.0']);
  assert.equal(verifyMainRelease(f.context(), f.git), true);
  f.git(['tag', '-a', 'v1.0.1-rc.1', '-m', 'Fixture']);
  assert.equal(verifyMainRelease(f.context('v1.0.1-rc.1'), f.git), true);
});

test('tag em outra branch e tag antiga não permitem publicar outro commit', (t) => {
  const f = fixture(t);
  f.git(['tag', 'v1.0.0']);
  f.git(['checkout', '-b', 'staging']);
  const other = f.commit();
  f.git(['tag', 'v2.0.0']);
  assert.throws(
    () => verifyMainRelease(f.context('v2.0.0', other), f.git),
    /HEAD atual de main/,
  );
  f.git(['checkout', 'main']);
  f.commit();
  f.git(['push', 'origin', 'main']);
  f.git(['checkout', f.sha]);
  assert.throws(
    () => verifyMainRelease(f.context(), f.git),
    /HEAD atual de main/,
  );
});

test('recriação/movimentação de tag, exclusão, checkout errado e eventos inconsistentes são recusados', (t) => {
  const f = fixture(t);
  f.git(['tag', 'v1.0.0']);
  for (const patch of [
    { created: false },
    { deleted: true },
    { forced: true },
    { ref: 'refs/heads/staging' },
  ]) {
    const event = f.context();
    Object.assign(event.event, patch);
    assert.throws(() => verifyMainRelease(event, f.git));
  }
  assert.throws(() => verifyMainRelease(f.context('vlatest'), f.git), /MAJOR/);
  assert.throws(
    () => verifyMainRelease({ ...f.context(), sha: 'a'.repeat(40) }, f.git),
    /Checkout/,
  );
  f.commit();
  assert.throws(() => verifyMainRelease(f.context(), f.git), /Checkout/);
});

test('CLI verifica main no remoto e bloqueia execução direta do deploy fora de uma nova tag', (t) => {
  const f = fixture(t);
  f.git(['tag', 'v1.0.0']);
  const eventPath = join(f.root, 'event.json'),
    output = join(f.root, 'output.txt'),
    script = fileURLToPath(
      new URL('../scripts/ci/release-policy.mjs', import.meta.url),
    );
  writeFileSync(eventPath, JSON.stringify(f.context().event));
  const env = {
    ...process.env,
    GITHUB_EVENT_NAME: 'push',
    GITHUB_REF: 'refs/tags/v1.0.0',
    GITHUB_SHA: f.sha,
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_OUTPUT: output,
  };
  const invoke = (options) =>
    spawnSync(process.execPath, [script, '--require-deploy'], {
      cwd: f.work,
      env: { ...env, ...options },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
    });
  const shadow = join(f.root, 'untrusted');
  mkdirSync(shadow);
  writeFileSync(join(shadow, 'git'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  writeFileSync(join(shadow, 'git.cmd'), '@exit /b 99\r\n');
  assert.equal(
    invoke({ PATH: shadow }).status,
    0,
    'release must not resolve git from an untrusted PATH',
  );
  assert.equal(invoke().status, 0);
  assert.equal(readFileSync(output, 'utf8'), 'deploy=true\n');
  const manual = invoke({ GITHUB_EVENT_NAME: 'workflow_dispatch' });
  assert.equal(manual.status, 1);
  assert.match(manual.stderr, /Deploy recusado/);
  f.commit();
  f.git(['push', 'origin', 'main']);
  f.git(['checkout', f.sha]);
  const stale = invoke();
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /HEAD atual de main/);
});

test('workflow não oferece deploy manual e o script exige a política antes das credenciais SSH', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/ci-vps.yml', import.meta.url),
    'utf8',
  );
  assert.match(workflow, /tags: \['v\*'\]/);
  assert.doesNotMatch(workflow, /inputs\.deploy|VPS_AUTO_DEPLOY/);
  assert.match(workflow, /github\.event\.created == true/);
  assert.match(workflow, /needs\.release_policy\.outputs\.deploy == 'true'/);
  assert.match(
    workflow,
    /needs: \[release_policy, validate, sonarqube, image\]/,
  );
  const deploy = readFileSync(
    new URL('../scripts/ci/deploy-vps.sh', import.meta.url),
    'utf8',
  );
  assert.ok(
    deploy.indexOf('release-policy.mjs --require-deploy') <
      deploy.indexOf('VPS_SSH_PRIVATE_KEY'),
  );
});
