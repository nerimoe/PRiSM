# Koishi Structured Mahjong Configuration Implementation Plan

**Goal:** Replace the human-parsed Mahjong table text editor with a native Koishi structured list while retaining legacy configuration compatibility.

1. Add a failing parser/configuration test for structured tables and legacy fallback precedence.
2. Add `mahjongTableConfigs` as `Schema.array(Schema.object(...))` with table ID, display name, aliases, and pricing ID list fields.
3. Normalize structured entries to the existing Mahjong configuration model; use them whenever non-empty, otherwise parse legacy text.
4. Update README and bump the plugin package patch version.
5. Run typecheck, full plugin tests, build, whitespace check, and commit generated output.
