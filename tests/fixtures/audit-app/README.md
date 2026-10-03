# audit-app fixture

Fake SvelteKit tree for `tests/audit*.test.ts`. Not a runnable app.

Secret-shaped values are stored as placeholders (`__FAKE_STRIPE__`,
`__FAKE_AWS__`, `__FAKE_SERVICE_ROLE__`, `__FAKE_ANON_JWT__`). The tests copy
this directory to a temp dir, replace the placeholders with fake values built
at runtime, rename `_gitignore` to `.gitignore` and `env.fixture` to `.env`,
so the repository never contains a literal that secret scanners would flag
(and the outer repo's git never sees an active nested `.gitignore`).
