# Governance

## Current model

runtime-upgrade is maintained by one person: [@aasisdhakal](https://github.com/aasisdhakal).

That is worth stating plainly rather than implying a committee. It means:

- **Reviews can be slow.** There is no rota and no on-call. If something is
  urgent for you, say so in the issue.
- **There is a bus factor of one.** If you depend on this, vendor it or fork it.
  It is MIT licensed precisely so you can.
- **Decisions are made by the maintainer.** Discussion in an issue is genuinely
  welcome and will change outcomes, but there is no vote to lose.

## Maintainers

| GitHub | Scope |
|---|---|
| [@aasisdhakal](https://github.com/aasisdhakal) | everything |

## How decisions get made

- **Bug fixes and new language rules** — open a PR. If it has a test that fails
  before and passes after, it will usually be merged.
- **Behaviour changes** — open an issue first. The ones that matter here are
  changes to what the tool WRITES, and to the floor-versus-pin rules. Those are
  the places where being wrong silently breaks someone's repo.
- **Licence or security policy changes** — maintainer only.

## Becoming a maintainer

There is no formal process yet, because there has not needed to be one. If you
have landed several non-trivial changes and want commit access, open an issue
and ask. The honest bar is: do you understand why a floor is not a pin, and why
an autofix is only ever allowed to be a pure rename?

## If this project becomes unmaintained

If there has been no response to issues for six months, consider the project
dormant and fork it. Please rename your fork so users can tell them apart. No
permission is needed beyond the MIT licence.
