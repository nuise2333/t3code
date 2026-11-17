# DeepSeek Stack preset

The `DeepSeek Stack` agent preset packages
[aicodeking/deepseek-stack](https://github.com/aicodeking/deepseek-stack) for
DeepSeek Harness. `scripts/dsh-acp.mjs` mounts `preset.patch.yml` beside the
shipped DSH presets, and the T3 bridge exposes it as an **Agent preset** choice.

The preset puts the pack's always-on `ds-mode` working style and a routing table
in the persona, and mounts `skills/` as an extra `skill-filesystem` root. The
table maps each kind of request, with Chinese cue words, to the skill the agent
loads before its first other tool call, plus the phase changes that load
`ds-verify-loop`, `ds-unstick` and `ds-review-loop`. The skill catalog alone is
not enough: it mixes the pack with every user and project skill and gives the
model only one-line descriptions, so without the table DeepSeek skipped the
pack on most coding requests. `scripts/dsh-acp-presets.test.mjs` fails when the
`ds-*` names in the preset and `skills/` disagree; route any new upstream skill after a refresh. Use the highest reasoning effort the model offers for planning
and review; upstream says it "matters more than any skill".

The skills are vendored (upstream commit `d4f1ebe72e8314c3a0c6135bb82f623c650f7218`,
2026-10-28, MIT) so the preset works offline and cannot drift with a network
fetch. To refresh them:

```bash
git clone --depth 1 https://github.com/aicodeking/deepseek-stack.git /tmp/deepseek-stack
cp -R /tmp/deepseek-stack/skills/. scripts/dsh-stack/skills/
cp /tmp/deepseek-stack/LICENSE scripts/dsh-stack/LICENSE
# Update the commit above, then review the diff.
```

`LICENSE` is the upstream MIT license. The skill text is upstream content; the
preset composition is T3's. The repository formatter normalizes the vendored
Markdown, so a refresh diff can include table alignment.
