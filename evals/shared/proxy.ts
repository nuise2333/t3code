// Eval-only helper: it reads the local Codex config through Python 3.11+ at startup.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as Schema from "effect/Schema";

// Read credentials into memory only. Python's TOML parser avoids another runner dependency.
const decodeProxyConfig = Schema.decodeUnknownSync(
  Schema.Struct({ url: Schema.String, headers: Schema.Record(Schema.String, Schema.String) }),
);
/**
 * Reads a CLIProxyAPI-compatible provider from `~/.codex/config.toml`: `vibeproxy`, or the one
 * `EVAL_PROXY_PROVIDER` names. `EVAL_PYTHON` picks the interpreter, since tomllib needs 3.11+.
 * `EVAL_PROXY_MODEL_PREFIX` routes to one upstream of a gateway, such as `copilot/` on magpie.
 */
export const proxyConfig = () => ({
  ...decodeProxyConfig(
    JSON.parse(
      NodeChildProcess.execFileSync(
        process.env.EVAL_PYTHON || "python3",
        [
          "-c",
          `
import json, os, pathlib, tomllib
home = pathlib.Path.home() / '.codex'
p = tomllib.loads((home / 'config.toml').read_text())['model_providers'][os.environ.get('EVAL_PROXY_PROVIDER') or 'vibeproxy']
h = p.get('http_headers', {}).copy()
h.update({k: os.environ[v] for k,v in p.get('env_http_headers', {}).items()})
key = os.environ[p['env_key']] if p.get('env_key') else p.get('experimental_bearer_token')
if not key and p.get('requires_openai_auth'): key = json.loads((home / 'auth.json').read_text()).get('OPENAI_API_KEY')
if key: h['Authorization'] = 'Bearer ' + key
print(json.dumps({'url': p['base_url'].rstrip('/'), 'headers': h}))
`,
        ],
        { encoding: "utf8" },
      ),
    ),
  ),
  modelPrefix: process.env.EVAL_PROXY_MODEL_PREFIX ?? "",
});
