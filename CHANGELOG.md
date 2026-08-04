# Changelog

## [1.2.0](https://github.com/anthonyhaussman/opencode-agy-auth/compare/1.1.10...1.2.0) (2026-08-04)


### Features

* add gemini-3.6-flash and align tier naming with agy 1.1.5 ([#24](https://github.com/anthonyhaussman/opencode-agy-auth/issues/24)) ([bdfd9ee](https://github.com/anthonyhaussman/opencode-agy-auth/commit/bdfd9ee3361386bbdb0bded565370ff7ac196f0a))
* add OSC8 terminal hyperlinks and bump AGY_CLI_VERSION to 1.0.12 ([#12](https://github.com/anthonyhaussman/opencode-agy-auth/issues/12)) ([dc5a750](https://github.com/anthonyhaussman/opencode-agy-auth/commit/dc5a750bad49364ada198104c85fcc7bfdf9c88b))
* bootstrap opencode-agy-auth plugin v1.0.7 ([4a940f2](https://github.com/anthonyhaussman/opencode-agy-auth/commit/4a940f25519985df001625327da8dc93c1bcf3e7))
* bump SDK version to 1.0.8 and implement dynamic User-Agent caching ([#4](https://github.com/anthonyhaussman/opencode-agy-auth/issues/4)) ([1f2b9ab](https://github.com/anthonyhaussman/opencode-agy-auth/commit/1f2b9abec8b6445ab3f4d335b1348c694f1f5067))
* implement dynamic model cost resolver via models.dev API ([#28](https://github.com/anthonyhaussman/opencode-agy-auth/issues/28)) ([95f1ccf](https://github.com/anthonyhaussman/opencode-agy-auth/commit/95f1ccf5d580c3ace769be8a69811d914bbdde8f))
* **plugin:** add /agyquotasummary command and tool ([#8](https://github.com/anthonyhaussman/opencode-agy-auth/issues/8)) ([d446aaa](https://github.com/anthonyhaussman/opencode-agy-auth/commit/d446aaa718b8993226830e6fc9289e6e6d80aa47))
* **release:** automate releases with release-please ([#34](https://github.com/anthonyhaussman/opencode-agy-auth/issues/34)) ([4650dcf](https://github.com/anthonyhaussman/opencode-agy-auth/commit/4650dcff7977700becbece0d6a13127fbaa5fcd2))


### Bug Fixes

* **agy:** map gemini-3.5-flash tiers to live server ids ([#25](https://github.com/anthonyhaussman/opencode-agy-auth/issues/25)) ([109090b](https://github.com/anthonyhaussman/opencode-agy-auth/commit/109090b6c8269b8f2567414d5df5ed7c70999037))
* **agy:** override minimal variant to bypass M16 budget:0 rejection ([#32](https://github.com/anthonyhaussman/opencode-agy-auth/issues/32)) ([7ec23e5](https://github.com/anthonyhaussman/opencode-agy-auth/commit/7ec23e57c50a05cebed1aad0eeb8d7cfe6da07d5))
* **agy:** resolve Gemini 3.5 Flash silent stops and missing thought signatures ([#5](https://github.com/anthonyhaussman/opencode-agy-auth/issues/5)) ([c45b5c1](https://github.com/anthonyhaussman/opencode-agy-auth/commit/c45b5c13b7c6a09d05891679c0f2355f73ce4562))
* align model capabilities schema with OpenCode v2 root properties… ([#26](https://github.com/anthonyhaussman/opencode-agy-auth/issues/26)) ([ccd033a](https://github.com/anthonyhaussman/opencode-agy-auth/commit/ccd033a7a6079c6b4af3cae81c9ca66fb191e018))
* **auth:** retry loadCodeAssist on 429 via fetchWithRetry ([#17](https://github.com/anthonyhaussman/opencode-agy-auth/issues/17)) ([a0f6b99](https://github.com/anthonyhaussman/opencode-agy-auth/commit/a0f6b99484753c7369be51b3e4443a021f276942))
* change prepack script to use npm instead of pnpm ([0d4ae33](https://github.com/anthonyhaussman/opencode-agy-auth/commit/0d4ae3396a111f75f01d1325b0c016568429d64a))
* handle orphaned tool responses in sequence ([#7](https://github.com/anthonyhaussman/opencode-agy-auth/issues/7)) ([addd0bb](https://github.com/anthonyhaussman/opencode-agy-auth/commit/addd0bb542c64a1fb492a5ec69f42e67d67ac834))
* local plugin crash + add persistent state tracking, SHA-256 hashing, and cooldown disk persistence ([#10](https://github.com/anthonyhaussman/opencode-agy-auth/issues/10)) ([8003ba5](https://github.com/anthonyhaussman/opencode-agy-auth/commit/8003ba5b77edaa7e19d5e5277d2cbaba2fe4e3bd))
* **plugin:** add name and displayName to model variants for TUI footer visibility ([#3](https://github.com/anthonyhaussman/opencode-agy-auth/issues/3))` ([be8666f](https://github.com/anthonyhaussman/opencode-agy-auth/commit/be8666f52cdfc2b236cd502c7b413bff99d96387))
* **plugin:** prevent ReferenceError on global DOM constructors ([#2](https://github.com/anthonyhaussman/opencode-agy-auth/issues/2)) ([dcc1f68](https://github.com/anthonyhaussman/opencode-agy-auth/commit/dcc1f681c6049783ad49bee39ae4bacd4d64cb8f))
* remove medium tier from gemini-3.1-pro ([#14](https://github.com/anthonyhaussman/opencode-agy-auth/issues/14)) ([05082cd](https://github.com/anthonyhaussman/opencode-agy-auth/commit/05082cdc0a2455b1908feeb7d37973796805721c))
* **stream:** support multi-line SSE events in streaming transformer ([#9](https://github.com/anthonyhaussman/opencode-agy-auth/issues/9)) ([ab835cb](https://github.com/anthonyhaussman/opencode-agy-auth/commit/ab835cbfed36fa38f9aafcfe0338d3725023d6cf))
* **traffic:** retry 5xx on v1internal endpoints and suppress transient warnings ([#16](https://github.com/anthonyhaussman/opencode-agy-auth/issues/16)) ([eaab73d](https://github.com/anthonyhaussman/opencode-agy-auth/commit/eaab73dbfe983699f6217cf4643700154ae9d697))
