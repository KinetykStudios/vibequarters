# Third-party notices

VibeQuarters vendors the following code. Each keeps its own license file in its folder.

| Library | Version | License | Where | License file |
| --- | --- | --- | --- | --- |
| [three.js](https://threejs.org/) | 0.186.0 (npm package `three`) | MIT, Copyright 2010-2026 three.js authors | `vendor/three/` | [`vendor/three/LICENSE`](vendor/three/LICENSE) |

Only the files the page imports, and the files those import, are vendored. `vendor/three/SHA256SUMS` lists their checksums, and `tools/vendor-three.cjs` shows how they were taken from the npm registry tarball.

The `system/skills` folder bundles one skill, installed only with the `skills` pack. Its text is kept as published except for the change noted.

| Skill | Version | License | Where | Changes |
| --- | --- | --- | --- | --- |
| vibesec | as published | Apache-2.0 ([`LICENSE`](system/skills/vibesec/LICENSE)) | `system/skills/vibesec/` | From [BehiSecc/VibeSec-Skill](https://github.com/BehiSecc/VibeSec-Skill). In `SKILL.md`: the frontmatter description was rewritten, and the note at the top was added. |

The people in the office are models, kept in `assets/people/`.

| Models | License | Where | Changes |
| --- | --- | --- | --- |
| [Microsoft Rocketbox Avatar Library](https://github.com/microsoft/Microsoft-Rocketbox), 13 of its people | MIT, Copyright Microsoft Corporation ([`LICENSE`](assets/people/LICENSE)) | `assets/people/*.glb` | Converted from FBX to GLB, textures made smaller, files renamed. |

VibeQuarters has no npm dependencies. Its only binary files are those models and the pictures and film of the demo in `docs/media/`. No fonts or audio files are included.

Optional tools you may install yourself (Claude Code, whisper.cpp, an ElevenLabs account) are not part of this repository and come under their own terms.
