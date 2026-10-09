# Changelog

## [1.3.2](https://github.com/anthonyhaussman/opencode-agy-auth/compare/1.3.1...1.3.2) (2026-10-09)


### Features

* **agy:** bump agy CLI to v1.3.2 ([e63cf5f](https://github.com/anthonyhaussman/opencode-agy-auth/commit/e63cf5fbef47931befe8a715d5a71b080d6225b7))


### Build System

* **deps:** bump hashgraph-online/ai-plugin-scanner-action ([5bb5285](https://github.com/anthonyhaussman/opencode-agy-auth/commit/5bb52859baf0e87914e5583ed513d29fe60717d4))

## [1.3.1](https://github.com/anthonyhaussman/opencode-agy-auth/compare/1.3.0...1.3.1) (2026-10-07)


### Features

* **agy:** bump agy CLI to v1.3.1 ([f4e361a](https://github.com/anthonyhaussman/opencode-agy-auth/commit/f4e361a4266cceafb6d0268fbda54aa17337d473))

## [1.3.0](https://github.com/anthonyhaussman/opencode-agy-auth/compare/1.2.17...1.3.0) (2026-10-07)


### Features

* **agy:** bump agy CLI to v1.3.0 ([7f69062](https://github.com/anthonyhaussman/opencode-agy-auth/commit/7f6906207c0bed84e25a0285ba0e631f02ed8696))
* **agy:** refresh models catalogue for agy v1.3.0 ([8c56988](https://github.com/anthonyhaussman/opencode-agy-auth/commit/8c569883ecc815cb6943bd03ef4e9195d2e831b5))
* export dual v1/v2 plugin entrypoint from index.ts ([3072ab2](https://github.com/anthonyhaussman/opencode-agy-auth/commit/3072ab23c77aeb5bf9653082602e5d07a25f6f6f))
* **types:** define opencode v2 plugin contracts and helpers ([64ce65b](https://github.com/anthonyhaussman/opencode-agy-auth/commit/64ce65bc5c524e1890f29a62046cc2455f9d3396))
* **v2:** implement opencode v2 plugin setup adapter ([610027f](https://github.com/anthonyhaussman/opencode-agy-auth/commit/610027feae3edb101d21c77c1cc8535f176a00af))


### Bug Fixes

* **prepare:** sanitize parameters_json_schema in tool definitions ([c1f8bde](https://github.com/anthonyhaussman/opencode-agy-auth/commit/c1f8bdedf51954091dd04271a3d40c381531622b))
* **test:** mock browser launcher and stub stored auth in v2 tests ([cdb90e9](https://github.com/anthonyhaussman/opencode-agy-auth/commit/cdb90e93dd9bf3c53798e5c17975c4e9dd5e36f0))
* **test:** prevent browser popup during coverage runs ([e24a421](https://github.com/anthonyhaussman/opencode-agy-auth/commit/e24a421d2111e642838ddc8542a7c6924ad3f954))
* **v2:** add integration transform and filter session hooks ([8b62da4](https://github.com/anthonyhaussman/opencode-agy-auth/commit/8b62da4599fa7067fe19355d0d0f7514d07c207b))
* **v2:** align oauth credential schema and request transforms ([0b7f1d6](https://github.com/anthonyhaussman/opencode-agy-auth/commit/0b7f1d6d81695d38374be92cafc95636c5cd5c41))
* **v2:** avoid mutating read-only Request url ([958e0c7](https://github.com/anthonyhaussman/opencode-agy-auth/commit/958e0c734972f32ecca1d85a48f226036d2a6f3a))
* **v2:** await transform response in http hook ([2cefe73](https://github.com/anthonyhaussman/opencode-agy-auth/commit/2cefe736a38a4e698e9a95d288112b5ca3fb92ed))
* **v2:** configure aisdk provider package and register model variants ([2d1c856](https://github.com/anthonyhaussman/opencode-agy-auth/commit/2d1c856cff13003acd46ec3e2456f2e844a00b2c))
* **v2:** implement aisdk hook and complete oauth authorize flow ([a2751cf](https://github.com/anthonyhaussman/opencode-agy-auth/commit/a2751cfbd433fdff7bfda5fd212bfbf551361f0a))
* **v2:** persist AGY OAuth auth atomically ([9cf6aef](https://github.com/anthonyhaussman/opencode-agy-auth/commit/9cf6aefa5b735357e849f1b75e9d3ada56642c3c))
* **v2:** support opencode v2 catalog and tool editor apis ([f268725](https://github.com/anthonyhaussman/opencode-agy-auth/commit/f268725f0631dec1a2ad947832bbd472415e8bcb))
* **v2:** support provider and model registries ([268b1a2](https://github.com/anthonyhaussman/opencode-agy-auth/commit/268b1a2a4ce045f75d437599b00f97ec8109c1ce))
* **v2:** use pkce authorize flow and inject stored auth ([9a1e181](https://github.com/anthonyhaussman/opencode-agy-auth/commit/9a1e18181ce52995881597d92842c59279dee454))


### Refactor

* **v2:** modularize opencode v2 adapter ([d7e9001](https://github.com/anthonyhaussman/opencode-agy-auth/commit/d7e9001207f11466167e855abcdec4ab89ba607d))


### Documentation

* **agents:** document opencode v2 adapter and oauth flow ([cf75a69](https://github.com/anthonyhaussman/opencode-agy-auth/commit/cf75a6914fc57d3763bff0a532296ef97bbc25e1))
* document opencode v1 and v2 dual architecture in agents.md ([bfbfcd6](https://github.com/anthonyhaussman/opencode-agy-auth/commit/bfbfcd6015c8f24dfe80ffa3d07cb2de55d789af))
* document opencode v1 and v2 dual compatibility ([33a91f3](https://github.com/anthonyhaussman/opencode-agy-auth/commit/33a91f38cab8ef149c7b4de3c7c73297ae47ed01))
* **readme:** graduate opencode v2 support from alpha ([cae27b9](https://github.com/anthonyhaussman/opencode-agy-auth/commit/cae27b9db8cb1d7c2b0ecb88833b6187433ad9eb))


### Tests

* add comprehensive integration tests for opencode v2 adapter ([dfe8c4a](https://github.com/anthonyhaussman/opencode-agy-auth/commit/dfe8c4a4be0a999306be73ac675db00c62ba33d5))
* **coverage:** replace html reporter with lcov ([2ef0efd](https://github.com/anthonyhaussman/opencode-agy-auth/commit/2ef0efd4ce4bcc383e5eb21a6457c518df2b7a91))
* **v2:** increase test coverage for http request hook ([7ce1d8d](https://github.com/anthonyhaussman/opencode-agy-auth/commit/7ce1d8d22cf346e3dfa3b432dca60a0972ef8e9c))
* **v2:** update model assertions for claude 5.5 ([3a774f8](https://github.com/anthonyhaussman/opencode-agy-auth/commit/3a774f8dd113fa7ecfc097a55efda602aa5530d4))

## [1.2.17](https://github.com/anthonyhaussman/opencode-agy-auth/compare/1.2.16...1.2.17) (2026-10-06)


### Features

* **sdk:** bump agy cli to 1.2.17 ([a3040f9](https://github.com/anthonyhaussman/opencode-agy-auth/commit/a3040f908ab4a953e2ec7f477e59c5288187a28d))


### Bug Fixes

* **sdk:** sanitize invalid thinking blocks for Claude models ([3bb55ae](https://github.com/anthonyhaussman/opencode-agy-auth/commit/3bb55aeedba548c422f975fe9723c4a877aa1dd0))
* **sdk:** set dynamic used_claude label for Claude models ([5ef40df](https://github.com/anthonyhaussman/opencode-agy-auth/commit/5ef40df3ca09b8467630b310741723533997e9d2))

## [1.2.16](https://github.com/anthonyhaussman/opencode-agy-auth/compare/1.2.14...1.2.16) (2026-10-03)


### Features

* **models:** register claude 5.5 models and tiers ([ea39435](https://github.com/anthonyhaussman/opencode-agy-auth/commit/ea39435e7ff12cc4e7a322d1f97f3dac0ccbcd1d))
* **sdk:** bump agy cli to 1.2.16 ([cfe3fbe](https://github.com/anthonyhaussman/opencode-agy-auth/commit/cfe3fbe6b396cdb8b9ddb781ab99185aa3085079))


### Build System

* **deps:** bump hashgraph-online/ai-plugin-scanner-action ([cb96a8c](https://github.com/anthonyhaussman/opencode-agy-auth/commit/cb96a8c12d7c6e0ac23cbc3950aa9bfe86edfb9e))

## [1.2.14](https://github.com/anthonyhaussman/opencode-agy-auth/compare/1.2.13...1.2.14) (2026-09-30)


### Features

* **sdk:** bump agy cli to 1.2.14 ([85a6c4f](https://github.com/anthonyhaussman/opencode-agy-auth/commit/85a6c4f986b39c99bf72d9ff390709255a08a45a))

## [1.2.13](https://github.com/anthonyhaussman/opencode-agy-auth/compare/1.2.12...1.2.13) (2026-09-29)


### Features

* **sdk:** bump agy cli to 1.2.13 ([2969fe6](https://github.com/anthonyhaussman/opencode-agy-auth/commit/2969fe69c80f67d47cd7b015866bdfd0edafedd6))


### Documentation

* add badges to README header ([ce150ab](https://github.com/anthonyhaussman/opencode-agy-auth/commit/ce150ab133c27459ff302e58ca1a47d1fe34a540))
* add soft star call-to-action to README ([26813f0](https://github.com/anthonyhaussman/opencode-agy-auth/commit/26813f07c9a7a8133c02a550472a671fdfdeed90))

## [1.2.12](https://github.com/anthonyhaussman/opencode-agy-auth/compare/1.2.11...1.2.12) (2026-09-28)


### Features

* **agy:** bump agy CLI to v1.2.12 ([f1f7bcf](https://github.com/anthonyhaussman/opencode-agy-auth/commit/f1f7bcf53e1d644846ccb0ea0d7b5cdfe5d7e474))

## [1.2.11](https://github.com/anthonyhaussman/opencode-agy-auth/compare/1.2.10...1.2.11) (2026-09-25)


### Features

* **agy:** bump agy CLI to v1.2.11 ([63e299d](https://github.com/anthonyhaussman/opencode-agy-auth/commit/63e299df31cba54d18091346f7321218f9a7d6ec))


### Documentation

* **agents:** document scanner verification and client credentials ([68ee1b2](https://github.com/anthonyhaussman/opencode-agy-auth/commit/68ee1b22cd87443b8931d19e0df361a454adc20f))


### Build System

* **deps:** bump actions/checkout from 4.2.2 to 7.0.1 ([5993a3b](https://github.com/anthonyhaussman/opencode-agy-auth/commit/5993a3b7905ed17a5d7addca9fbe8d7b844a00fe))
* **deps:** bump actions/setup-node from 4.2.0 to 7.0.0 ([43026a5](https://github.com/anthonyhaussman/opencode-agy-auth/commit/43026a5260c2642aa832ce9c814ccdc816e87cd1))
* **deps:** bump googleapis/release-please-action from 4.1.4 to 5.0.0 ([71d7b61](https://github.com/anthonyhaussman/opencode-agy-auth/commit/71d7b61a12f3bb526baadf4e8fd553f6a4f2e57c))
* **deps:** bump hashgraph-online/ai-plugin-scanner-action ([988800c](https://github.com/anthonyhaussman/opencode-agy-auth/commit/988800c1cca752e165d817811882959995a28615))


### Continuous Integration

* **scanner:** restrict push triggers to main branch ([dd45db6](https://github.com/anthonyhaussman/opencode-agy-auth/commit/dd45db6b342c3dc55e91ac9aa1a2da3842cc5995))
* **scanner:** set failure threshold to critical for public credentials ([8b4695c](https://github.com/anthonyhaussman/opencode-agy-auth/commit/8b4695c2a0442101188000a8a9627193cf8409bf))

## [1.2.10](https://github.com/anthonyhaussman/opencode-agy-auth/compare/1.2.9...1.2.10) (2026-09-24)


### Features

* **agy:** bump agy CLI to v1.2.10 ([36aa27f](https://github.com/anthonyhaussman/opencode-agy-auth/commit/36aa27f44363f3c8d3af65968f0544470bd0881d))

## [1.2.9](https://github.com/anthonyhaussman/opencode-agy-auth/compare/1.2.8...1.2.9) (2026-09-23)


### Features

* **agy:** bump agy CLI to v1.2.9 ([661cc32](https://github.com/anthonyhaussman/opencode-agy-auth/commit/661cc32b512986915baf7194c813c89d598c6efa))

## [1.2.8](https://github.com/anthonyhaussman/opencode-agy-auth/compare/1.2.7...1.2.8) (2026-09-22)


### Features

* **agy:** bump agy CLI to v1.2.8 ([324741d](https://github.com/anthonyhaussman/opencode-agy-auth/commit/324741d5f4fa5096ba14f3daefc823f2ee8ffe94))


### Documentation

* **agents:** require dependency upgrade in bump workflow ([044b323](https://github.com/anthonyhaussman/opencode-agy-auth/commit/044b32358f5ee6c3d207c6e5b3b358d00d16b4d0))

## [1.2.7](https://github.com/anthonyhaussman/opencode-agy-auth/compare/1.2.6...1.2.7) (2026-09-19)


### Features

* **agy:** bump agy CLI to v1.2.7 ([befabf2](https://github.com/anthonyhaussman/opencode-agy-auth/commit/befabf225c60baf539b0f83ff6269a4e8e414d41))

## [1.2.6](https://github.com/anthonyhaussman/opencode-agy-auth/compare/1.2.5...1.2.6) (2026-09-18)


### Features

* **agy:** bump agy CLI to v1.2.6 ([2c0de96](https://github.com/anthonyhaussman/opencode-agy-auth/commit/2c0de961695a67671425853b6b8e4df71a141182))

## [1.2.5](https://github.com/anthonyhaussman/opencode-agy-auth/compare/1.2.4...1.2.5) (2026-09-17)


### Features

* **agy:** bump agy CLI to v1.2.5 ([523b145](https://github.com/anthonyhaussman/opencode-agy-auth/commit/523b145d241e7270ddb27a9f4e2dae42f184169e))

## [1.2.4](https://github.com/anthonyhaussman/opencode-agy-auth/compare/1.2.3...1.2.4) (2026-09-16)


### Features

* **agy:** bump agy CLI to v1.2.4 ([52b3700](https://github.com/anthonyhaussman/opencode-agy-auth/commit/52b3700919bcc75e5be20f1c73add43fde052b93))


### Documentation

* **readme:** note opencode v2 support in alpha ([0bb4a02](https://github.com/anthonyhaussman/opencode-agy-auth/commit/0bb4a0227acdc5b0d6e3d5bc04d32bcd246dc05f))

## [1.2.3](https://github.com/anthonyhaussman/opencode-agy-auth/compare/1.2.2...1.2.3) (2026-09-15)


### Features

* **agy:** bump agy CLI to v1.2.3 ([1ed1092](https://github.com/anthonyhaussman/opencode-agy-auth/commit/1ed10922bc9a31f708c0fc3c5a230fa0ae01a377))


### Bug Fixes

* **request:** stringify tool schema enums for Gemini API ([cd09046](https://github.com/anthonyhaussman/opencode-agy-auth/commit/cd090462f6169b98e27c0d2cd32f8f167ce0fcae))

## [1.2.2](https://github.com/anthonyhaussman/opencode-agy-auth/compare/1.2.1...1.2.2) (2026-09-12)


### Features

* **agy:** bump agy CLI to v1.2.2 ([5133c16](https://github.com/anthonyhaussman/opencode-agy-auth/commit/5133c16c0732f32855a81be100e8420f927ac008))

## [1.2.1](https://github.com/anthonyhaussman/opencode-agy-auth/compare/1.2.0...1.2.1) (2026-09-11)


### Features

* **agy:** bump agy CLI to v1.2.1 ([03d5d44](https://github.com/anthonyhaussman/opencode-agy-auth/commit/03d5d44c054d65b84949b788f9a94745c53118ab))


### Build System

* **package:** add repository and homepage URLs ([3f3dab9](https://github.com/anthonyhaussman/opencode-agy-auth/commit/3f3dab98915aba2b9b86f6cb872d95277ddbc231))

## [1.2.0](https://github.com/anthonyhaussman/opencode-agy-auth/compare/1.1.28...1.2.0) (2026-09-10)


### Features

* **agy:** bump agy CLI to v1.2.0 ([a069af1](https://github.com/anthonyhaussman/opencode-agy-auth/commit/a069af160a848990d4f8e81a417906995aca2096))

## [1.1.28](https://github.com/anthonyhaussman/opencode-agy-auth/compare/1.1.27...1.1.28) (2026-09-09)


### Features

* **sdk:** bump agy cli to 1.1.28 ([4a6e353](https://github.com/anthonyhaussman/opencode-agy-auth/commit/4a6e353b2b7e4b629fd581f4b20995bec6d77c32))


### Bug Fixes

* **release:** use changelog-sections key in release-please config ([45f22c9](https://github.com/anthonyhaussman/opencode-agy-auth/commit/45f22c90fce2e4fcf4f46d3a7917a4d59eca0a78))


### Refactor

* **models:** remove deprecated gemini-3.5-flash ([6834c69](https://github.com/anthonyhaussman/opencode-agy-auth/commit/6834c692e4b0d56bfc93ea84b3a2020217b62b36))


### Documentation

* **readme:** document alpha release and opencode-quota ([9f4529c](https://github.com/anthonyhaussman/opencode-agy-auth/commit/9f4529c49c38d59a962fb2409f3dc915aab5b964))
* **readme:** move alpha channel section to end ([6da1a5d](https://github.com/anthonyhaussman/opencode-agy-auth/commit/6da1a5dd80763e6bc5cf8a09f2d10ead7bfe14f3))

## [1.1.27](https://github.com/anthonyhaussman/opencode-agy-auth/compare/1.1.26...1.1.27) (2026-09-05)


### Features

* **request:** route gemini-3.5-flash-lite to checkpoint ([b73487e](https://github.com/anthonyhaussman/opencode-agy-auth/commit/b73487ede2e956334bab31c303004f7d25617e0b))
* **sdk:** bump agy cli to 1.1.27 ([4c2f72f](https://github.com/anthonyhaussman/opencode-agy-auth/commit/4c2f72f74c4c9435a044131fabc30e9946ef05d5))

## [1.1.26](https://github.com/anthonyhaussman/opencode-agy-auth/compare/1.1.25...1.1.26) (2026-09-04)


### Features

* **sdk:** bump agy cli to 1.1.26 ([308cf1e](https://github.com/anthonyhaussman/opencode-agy-auth/commit/308cf1e3ee342de14d313bed8ecf7ed718312ec8))

## [1.1.25](https://github.com/anthonyhaussman/opencode-agy-auth/compare/1.1.24...1.1.25) (2026-09-03)


### Features

* **models:** add and register Gemini 3.8 Flash ([#83](https://github.com/anthonyhaussman/opencode-agy-auth/issues/83)) ([84035c2](https://github.com/anthonyhaussman/opencode-agy-auth/commit/84035c2ff79af9cf0c70e032c54e031eb8fff46a))
* **sdk:** bump agy cli to 1.1.25 ([#84](https://github.com/anthonyhaussman/opencode-agy-auth/issues/84)) ([6092772](https://github.com/anthonyhaussman/opencode-agy-auth/commit/6092772ae47d6ca6e126f5d173a19cd8696a7291))

## [1.1.24](https://github.com/anthonyhaussman/opencode-agy-auth/compare/1.1.23...1.1.24) (2026-09-02)


### Features

* **sdk:** bump agy cli to 1.1.24 ([#81](https://github.com/anthonyhaussman/opencode-agy-auth/issues/81)) ([ee99004](https://github.com/anthonyhaussman/opencode-agy-auth/commit/ee99004725f8e04d704acbdfb4a027957ebb0f1a))

## [1.1.23](https://github.com/anthonyhaussman/opencode-agy-auth/compare/1.1.22...1.1.23) (2026-09-01)


### Features

* **sdk:** bump agy cli to 1.1.23 ([#79](https://github.com/anthonyhaussman/opencode-agy-auth/issues/79)) ([65b1420](https://github.com/anthonyhaussman/opencode-agy-auth/commit/65b142066150d2316ed845c37f12421fd58afe84))


### Bug Fixes

* **request:** ensure trailing user turn in request contents ([#78](https://github.com/anthonyhaussman/opencode-agy-auth/issues/78)) ([92142af](https://github.com/anthonyhaussman/opencode-agy-auth/commit/92142afbbb7c07b833ab10446ce6f0242e075ac1))

## [1.1.22](https://github.com/anthonyhaussman/opencode-agy-auth/compare/1.1.21...1.1.22) (2026-08-27)


### Features

* **sdk:** bump agy cli to 1.1.22 ([#76](https://github.com/anthonyhaussman/opencode-agy-auth/issues/76)) ([e695457](https://github.com/anthonyhaussman/opencode-agy-auth/commit/e695457f101a71a74db45757bc16fdc4ee50a41f))

## [1.1.21](https://github.com/anthonyhaussman/opencode-agy-auth/compare/1.1.20...1.1.21) (2026-08-26)


### Features

* **sdk:** bump agy cli to 1.1.21 ([#74](https://github.com/anthonyhaussman/opencode-agy-auth/issues/74)) ([a2d1a09](https://github.com/anthonyhaussman/opencode-agy-auth/commit/a2d1a09019edcb7495e2641999200b1c0a2460dd))

## [1.1.20](https://github.com/anthonyhaussman/opencode-agy-auth/compare/1.1.19...1.1.20) (2026-08-25)


### Features

* **sdk:** bump agy cli to 1.1.20 ([#72](https://github.com/anthonyhaussman/opencode-agy-auth/issues/72)) ([710452f](https://github.com/anthonyhaussman/opencode-agy-auth/commit/710452fc44707c0c72fd0f82cc98cf141bc47cb5))

## [1.1.19](https://github.com/anthonyhaussman/opencode-agy-auth/compare/1.1.18...1.1.19) (2026-08-23)


### Features

* **models:** canonicalize and sort json keys on refresh ([#69](https://github.com/anthonyhaussman/opencode-agy-auth/issues/69)) ([a353a3a](https://github.com/anthonyhaussman/opencode-agy-auth/commit/a353a3a60d06fd130c529722c4e8fda8939a68cf))
* **sdk:** bump agy cli to 1.1.19 ([#70](https://github.com/anthonyhaussman/opencode-agy-auth/issues/70)) ([17e4861](https://github.com/anthonyhaussman/opencode-agy-auth/commit/17e48618861df5452d700e927426e9a4c8682562))

## [1.1.18](https://github.com/anthonyhaussman/opencode-agy-auth/compare/1.1.17...1.1.18) (2026-08-22)


### Features

* **sdk:** bump agy cli to 1.1.18 ([#67](https://github.com/anthonyhaussman/opencode-agy-auth/issues/67)) ([5aca353](https://github.com/anthonyhaussman/opencode-agy-auth/commit/5aca353ff91ef271e6b0e69af1eff71f9f706f60))

## [1.1.17](https://github.com/anthonyhaussman/opencode-agy-auth/compare/1.1.16...1.1.17) (2026-08-21)


### Features

* **sdk:** bump agy cli to 1.1.17 ([#65](https://github.com/anthonyhaussman/opencode-agy-auth/issues/65)) ([2bb2025](https://github.com/anthonyhaussman/opencode-agy-auth/commit/2bb20254211fe6bb8a5092f6ea9b6130646e2e0d))

## [1.1.16](https://github.com/anthonyhaussman/opencode-agy-auth/compare/1.1.15...1.1.16) (2026-08-20)


### Features

* **sdk:** bump agy cli to 1.1.16 ([#63](https://github.com/anthonyhaussman/opencode-agy-auth/issues/63)) ([a290181](https://github.com/anthonyhaussman/opencode-agy-auth/commit/a290181a82390ae3f60b625041cd1589bea4716b))

## [1.1.15](https://github.com/anthonyhaussman/opencode-agy-auth/compare/1.1.14...1.1.15) (2026-08-19)


### Features

* bump agy cli to 1.1.15 ([#61](https://github.com/anthonyhaussman/opencode-agy-auth/issues/61)) ([86d418d](https://github.com/anthonyhaussman/opencode-agy-auth/commit/86d418d068dd8bed66ceb37327a409910df9b641))

## [1.1.14](https://github.com/anthonyhaussman/opencode-agy-auth/compare/1.1.14-alpha.3...1.1.14) (2026-08-18)


### Features

* **release-please:** configure release 1.1.14 ([356c0c9](https://github.com/anthonyhaussman/opencode-agy-auth/commit/356c0c93519e28d690d601319319b9a6a191d368))

## [1.1.14-alpha.3](https://github.com/anthonyhaussman/opencode-agy-auth/compare/1.1.14-alpha.2...1.1.14-alpha.3) (2026-08-18)


### Features

* bump agy cli to 1.1.14 ([#58](https://github.com/anthonyhaussman/opencode-agy-auth/issues/58)) ([b8d7ec5](https://github.com/anthonyhaussman/opencode-agy-auth/commit/b8d7ec52e8a5057516066cc12cefbbc7a74a3f7b))
* **release-please:** configure prerelease alpha version 1.1.14-alpha.3 ([fd2bb00](https://github.com/anthonyhaussman/opencode-agy-auth/commit/fd2bb00b70581d2855c579c9cd0e41b5c17b0409))

## [1.1.14-alpha.2](https://github.com/anthonyhaussman/opencode-agy-auth/compare/1.1.14-alpha.1...1.1.14-alpha.2) (2026-08-18)


### Features

* **release-please:** configure prerelease alpha version 1.1.14-alpha.2 ([cf6dfb9](https://github.com/anthonyhaussman/opencode-agy-auth/commit/cf6dfb97ac02fc00574bdd4a54098238ab9c8fde))


### Bug Fixes

* **request:** attach thoughtSignature to part instead of functionCall ([#56](https://github.com/anthonyhaussman/opencode-agy-auth/issues/56)) ([eb73910](https://github.com/anthonyhaussman/opencode-agy-auth/commit/eb739103d77f7e101edfe0616ad3e481d21deee7))

## [1.1.14-alpha.1](https://github.com/anthonyhaussman/opencode-agy-auth/compare/1.1.14-alpha.0...1.1.14-alpha.1) (2026-08-18)


### Features

* **release-please:** configure prerelease alpha version 1.1.14-alpha.1 ([7aa9ba5](https://github.com/anthonyhaussman/opencode-agy-auth/commit/7aa9ba59e5eeeb26e4fa6961f86e2a7424428ba8))
* **retry:** wait for quota reset on exhaustion ([#54](https://github.com/anthonyhaussman/opencode-agy-auth/issues/54)) ([81e41a3](https://github.com/anthonyhaussman/opencode-agy-auth/commit/81e41a3724ce1387445601c17feb3e378e00ec32))

## [1.1.14-alpha.0](https://github.com/anthonyhaussman/opencode-agy-auth/compare/1.1.13...1.1.14-alpha.0) (2026-08-14)


### Features

* **request:** map tool name schemas for gemini api ([#51](https://github.com/anthonyhaussman/opencode-agy-auth/issues/51)) ([227877b](https://github.com/anthonyhaussman/opencode-agy-auth/commit/227877b09fdf2ad86b336dd9c5de37a59a31c8b0))

## [1.1.13](https://github.com/anthonyhaussman/opencode-agy-auth/compare/1.1.13-alpha.1...1.1.13) (2026-08-14)


### Features

* **release-please:** configure release 1.1.13 ([474e317](https://github.com/anthonyhaussman/opencode-agy-auth/commit/474e31787b51bddccc83aac18e7b6a47a4944f37))

## [1.1.13-alpha.1](https://github.com/anthonyhaussman/opencode-agy-auth/compare/1.1.13-alpha.0...1.1.13-alpha.1) (2026-08-14)


### Features

* **release-please:** configure prerelease alpha version 1.1.13-alpha.1 ([4a6360f](https://github.com/anthonyhaussman/opencode-agy-auth/commit/4a6360f0d071fcb36a381171f7be4e6e98fd4195))

## [1.1.13-alpha.0](https://github.com/anthonyhaussman/opencode-agy-auth/compare/1.1.11...1.1.13-alpha.0) (2026-08-13)


### Features

* add gemini-3.6-flash and align tier naming with agy 1.1.5 ([#24](https://github.com/anthonyhaussman/opencode-agy-auth/issues/24)) ([bdfd9ee](https://github.com/anthonyhaussman/opencode-agy-auth/commit/bdfd9ee3361386bbdb0bded565370ff7ac196f0a))
* add gemini-3.7-flash model tiers and refresh models catalog ([#45](https://github.com/anthonyhaussman/opencode-agy-auth/issues/45)) ([3097d03](https://github.com/anthonyhaussman/opencode-agy-auth/commit/3097d03829b69b3e29263424aa1df5304d8d2c43))
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

## [1.1.11](https://github.com/anthonyhaussman/opencode-agy-auth/compare/1.1.11...1.1.11) (2026-08-10)


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
