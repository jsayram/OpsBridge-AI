# OpsBridge AI documentation synchronization inventory

Verified: 2026-11-09T18:45:00-05:00, P6 rows and every row they replaced, by the P6 phase session: ten P6 and P7 notes written new, and the phase ledger, handoff, hub, session log and decision log overwritten only after each was read back and matched its recorded hash. The decision log was written twice: the first pass lost two backticked names to shell substitution, and the second, exact pass is the row below. Earlier: 2026-11-09T15:15:00-05:00, P5 rows and every row they replaced, by the P5 phase session. Earlier: 2026-11-09T14:16:05-05:00, inbox and ledger rows by the master; P4 rows; other rows unchanged since their own verification. Vault: `Jose-Ramirez-Vault`. All writes used the official Obsidian CLI, one note at a time with a 45-second hard timeout per call, and every note was read back through the CLI and compared with the exact bytes intended. Before overwriting, the handoff, decision log, session log and P4 phase guide were read and matched the hashes recorded below at P3. The hub did not: another writer had added a generated docs index, which was kept and extended. The phase ledger's pre-write hash was not kept, because a first sync pass stopped after that note and its output was overwritten by the rerun; the note was written from `docs/PHASE-LEDGER.md` and read back exact. The master inbox was read and matched its row, so it was not rewritten. A later source edit invalidates the matching row.

Earlier: 2026-11-06T17:55:00-05:00, P3 rows.

| Source | Vault destination | SHA-256 (source = read-back) | Bytes | Outcome |
|---|---|---|---:|---|
| `PRD.md` | `Projects/OpsBridge AI/PRD.md` | `95b85b6a6e817d9aabdadf8534f3cb7a0e196ec0408e733c6771752ef2ef5785` | 174870 | Verified |
| `docs/ROADMAP.md` | `Projects/OpsBridge AI/Roadmap.md` | `d5ee72d4af7a99da696ab727a22ced5a68f7ba71cc6bc3458e07ed34a47651d1` | 3703 | Verified |
| `docs/JOB-ALIGNMENT.md` | `Projects/OpsBridge AI/Job alignment.md` | `dcf59fbf7f8e17346c955744f55d7935e6e934a6bacd7ed4f30d3a48fd706ecd` | 17883 | Verified |
| `docs/VAULT-WORKFLOW.md` | `Projects/OpsBridge AI/Documentation workflow.md` | `82a543023023006005085e4f1b261918c3d80ff1de0bc83100a0a4018e766817` | 11207 | Verified |
| `docs/PHASE-LEDGER.md` | `Projects/OpsBridge AI/Phase ledger.md` | `41f7d6e911d2678d47b19f307f64842d855a49aed543193878d0961ef9198eb0` | 20902 | Verified |
| `docs/MASTER_INBOX.md` | `Projects/OpsBridge AI/Master inbox.md` | `60f5220403d42852beb1fc1b69f2f3547a18c2ce7e3e8266e931428537b3a462` | 14520 | Verified |
| `docs/SESSION_HANDOFF.md` | `Projects/OpsBridge AI/Handoff.md` | `8bb7779bc47dab9afbbdbf30d32226debbdb3fa799274ca71a5167d20d74fcec` | 10295 | Verified |
| `templates/work-package-brief.md` | `Projects/OpsBridge AI/Templates/work-package-brief.md` | `1ceefc08fa0bc714f4dd5dbedd0ae292fc31b74379b20d18ef91466cab3d59de` | 2719 | Verified |
| `templates/work-package-report.md` | `Projects/OpsBridge AI/Templates/work-package-report.md` | `5ef61afc8dab62d10dc37f052e56e2be679020fe0d9e48adb84587da26be671e` | 2406 | Verified |
| `templates/phase-review.md` | `Projects/OpsBridge AI/Templates/phase-review.md` | `bdbb64ff92f86d1f9b6ffcea9ff51ba90b897d76715b0a823a6f51d19bbc3734` | 1785 | Verified |
| `docs/briefs/P0.1.md` + `docs/reports/P0.1.md` | `Projects/OpsBridge AI/Phases/P0/P0.1 - Requirements and business process.md` | `5cdaf99d93fefcf78b743977339cfe014e7fe1a0d5bb884fe5bf179577caf8f1` | 5036 | Verified |
| `docs/briefs/P0.2.md` + `docs/reports/P0.2.md` | `Projects/OpsBridge AI/Phases/P0/P0.2 - Stack, hosting and ownership decision.md` | `627c929c50c222a061bac1ab0473fc0cb49ec6a51dda734167287bc6b613a013` | 7919 | Verified |
| `docs/briefs/P0.3.md` + `docs/reports/P0.3.md` | `Projects/OpsBridge AI/Phases/P0/P0.3 - Security model and integration contracts.md` | `61e9ec275f1d1e4d7923094a2489ef444dd9bd757b6b45e52a9e1daea82ce0b9` | 7118 | Verified |
| `docs/briefs/P0.4.md` + `docs/reports/P0.4.md` | `Projects/OpsBridge AI/Phases/P0/P0.4 - Experience and deterministic fixture plan.md` | `337b5768459df9d250781c45f07c75f16e38223e83b549b1a8c72a523750f1e8` | 5631 | Verified |
| `docs/briefs/P0.5.md` + `docs/reports/P0.5.md` | `Projects/OpsBridge AI/Phases/P0/P0.5 - Local scaffold and CI baseline.md` | `40fbefca8980d71353beb2dad4cae9cf582415b5f2adc2e37fbb496e8f629b44` | 6546 | Verified |
| `docs/briefs/P0.6.md` + `docs/reports/P0.6.md` | `Projects/OpsBridge AI/Phases/P0/P0.6 - Foundation review and owner gate.md` | `7d36274cf476b7c4ea041005549f3eb164885002530c0fe43ef812a76af5ea7d` | 7158 | Verified |
| `docs/reports/P0.md` | `Projects/OpsBridge AI/Phases/P0/P0 - Phase review.md` | `f44750589f6be8939e4fbcdcce634fbd585ece8e64eaaf2387b178a85217c9bb` | 3652 | Verified |
| `docs/briefs/P1.md` | `Projects/OpsBridge AI/Phases/P1/P1 - Phase brief.md` | `d84ab74e37066d5fc981861e61ada9bc318a19d799d9621bcd44bb42b7a2f7eb` | 5180 | Verified |
| PRD Section 14 P0; generated phase guide | `Projects/OpsBridge AI/Phases/P0.md` | `8e5ee5b0473119a2ea1e9fabea0698739fcf07d82b573f45a28e589d961f7d93` | 5544 | Verified |
| PRD Section 14 P1; generated phase guide | `Projects/OpsBridge AI/Phases/P1.md` | `3df879acd3dee92c1ff1362f5e78e622c6bafa9a17ebb9913af43c8fa27a846c` | 5400 | Verified |
| Generated coordinator project hub | `Projects/OpsBridge AI/OpsBridge AI.md` | `7c83136018ad0d65a840dcde1aa89fc0cf14de899a12033089954623c625db71` | 7485 | Verified |
| Generated decision log, appended | `Projects/OpsBridge AI/Decision log.md` | `0cf2791da66c73bfbce0a826e4ec3a237dd35d2e8e2899b25b5d113b163fa12a` | 8374 | Verified |
| Generated session log, appended | `Projects/OpsBridge AI/Session log.md` | `e08ba440533c52053389c0c98470e8f76b76083e2b57b10d5e18c7f95d6dc01d` | 18403 | Verified |
| PRD Section 14 P2; generated phase guide | `Projects/OpsBridge AI/Phases/P2.md` | `11b559ef6dd21a0b0c5772486fc7ee422d9f35a654c4ee6e4f8b3b6868226770` | 4261 | Verified |
| PRD Section 14 P3; generated phase guide | `Projects/OpsBridge AI/Phases/P3.md` | `598a90a9cefefb228fd2e19df509160736a605513306fdea0223c84559bd0844` | 6239 | Verified |
| PRD Section 14 P4; generated phase guide | `Projects/OpsBridge AI/Phases/P4.md` | `7af2c78e8aa15c28e2b5b4ea441775a8605bc83d7e12d34c1e3dd1b7629ce7cf` | 5015 | Verified |
| PRD Section 14 P5; generated phase guide | `Projects/OpsBridge AI/Phases/P5.md` | `165990f1ede76a62154a593bafa648e078023abc3f626a5e796e24d9f3bb9562` | 4366 | Verified, unchanged content |
| PRD Section 14 P6; generated phase guide | `Projects/OpsBridge AI/Phases/P6.md` | `beaf2e1e3743a82d142804d2ca1a74c184d6c6cabc3d4cf670218da102121011` | 4219 | Verified, unchanged content |
| PRD Section 14 P7; generated phase guide | `Projects/OpsBridge AI/Phases/P7.md` | `8bc41e633bf1297fed0f70b5084f2130477dd6b18f8875ad0d17a83d283ef424` | 4430 | Verified, unchanged content |
| PRD Section 14 P8; generated phase guide | `Projects/OpsBridge AI/Phases/P8.md` | `fc7f3e4559df94504975a56d44ebd7a327947a864f5a165db1360f0c21978436` | 5019 | Verified, unchanged content |
| `docs/briefs/P1.1.md` + `docs/reports/P1.1.md` | `Projects/OpsBridge AI/Phases/P1/P1.1 - Environment and release controls.md` | `b90f636b97252873b78ec31f3181b4657887385d9642ca0eba6d5c8860bce134` | 6908 | Verified |
| `docs/briefs/P1.2.md` + `docs/reports/P1.2.md` | `Projects/OpsBridge AI/Phases/P1/P1.2 - Owner identity boundary.md` | `48413ba62bdbcb21b51677cf43a4f03ad9bef963d1c1f64c1c72c01b58fd406f` | 6386 | Verified |
| `docs/briefs/P1.3.md` + `docs/reports/P1.3.md` | `Projects/OpsBridge AI/Phases/P1/P1.3 - Isolated guest workspaces.md` | `e39fd96dbf629cf027456afa80fea9ced9df5a7ba8483b91a82411d75defc572` | 7382 | Verified |
| `docs/briefs/P1.4.md` + `docs/reports/P1.4.md` | `Projects/OpsBridge AI/Phases/P1/P1.4 - Secure navigable shell.md` | `9607fdc5fbe31eee1e5953d317e02dc49928371d63e4d3aa3c7d67826ebe25b2` | 6186 | Verified |
| `docs/briefs/P1.5.md` + `docs/reports/P1.5.md` | `Projects/OpsBridge AI/Phases/P1/P1.5 - Staging proof and owner gate.md` | `4920282ee06e1b8f43306f4b73c5040389ef2eb27b67de9a9d2c137ea3cb66d7` | 4337 | Verified |
| `docs/reports/P1.md` | `Projects/OpsBridge AI/Phases/P1/P1 - Phase review.md` | `5602ee4d46a0164a53e839c507a37e2e77884f45b5d4284868c6bf0639a59330` | 6810 | Verified |
| `docs/briefs/P2.md` | `Projects/OpsBridge AI/Phases/P2/P2 - Phase brief.md` | `bd86fd671fa13f43935a853dd8cbc33b52f8150a32ef2f6c0e9db879a22740a6` | 5789 | Verified |
| `docs/runbooks/HOSTED-SETUP.md` | `Projects/OpsBridge AI/Phases/P1/Hosted setup steps for Jose.md` | `de1c84e7fabbd6986a581412f66dd2953c9ae7cae2316b5f08dc206a91cb55c1` | 3654 | Verified |
| `docs/briefs/P2.1.md` + `docs/reports/P2.1.md` | `Projects/OpsBridge AI/Phases/P2/P2.1 - Canonical schema and migrations.md` | `8f5026f6f6d5cd16d1e0b07e68b07b661abd5c891f71cf7d0733c0f6d4503bfd` | 7206 | Verified |
| `docs/briefs/P2.2.md` + `docs/reports/P2.2.md` | `Projects/OpsBridge AI/Phases/P2/P2.2 - Scoped case queries and edits.md` | `01aad017eb77ff5c9ed8721bd41b1d5c9725bca6be50aa03e3157e85d1720758` | 6000 | Verified |
| `docs/briefs/P2.3.md` + `docs/reports/P2.3.md` | `Projects/OpsBridge AI/Phases/P2/P2.3 - Consultant workflow and handoffs.md` | `7e76b946a6a70a2826c6f57f1bd4c312aa2b69f9f636c6828e4e755874e4ae49` | 5844 | Verified |
| `docs/briefs/P2.4.md` + `docs/reports/P2.4.md` | `Projects/OpsBridge AI/Phases/P2/P2.4 - Atomic approvals and audit events.md` | `74d9bfaa02fb2634242c0faaebb2ccd3f623cf48eb788226d8c04f3405f23aa1` | 6303 | Verified |
| `docs/briefs/P2.5.md` + `docs/reports/P2.5.md` | `Projects/OpsBridge AI/Phases/P2/P2.5 - Reproducibility and core gate.md` | `bf70fb376b333bc708bf832c7aa5fb05993069232dd2e7b05dee984448b31275` | 6340 | Verified |
| `docs/reports/P2.md` | `Projects/OpsBridge AI/Phases/P2/P2 - Phase review.md` | `4513b1f58d3af1056a348dff27163103b5df0960c52121255ed4f988b76bba79` | 7145 | Verified |
| `docs/briefs/P3.md` | `Projects/OpsBridge AI/Phases/P3/P3 - Phase brief.md` | `ef569fc54b0e3195d9d8665c9e1bc2665198a17e983f5197783088bb0306acb3` | 6554 | Verified |
| `docs/briefs/P3.1.md` + `docs/reports/P3.1.md` | `Projects/OpsBridge AI/Phases/P3/P3.1 - Source contracts and business definitions.md` | `e0b8b0c36d5e00ff255862c46da651380dae1d92ca7b368579460a69b1c27ad4` | 6491 | Verified |
| `docs/briefs/P3.2.md` + `docs/reports/P3.2.md` | `Projects/OpsBridge AI/Phases/P3/P3.2 - Simulated source ingestion.md` | `71745f9d9f52d748a97a32209b5fac0966c0eb23b59953e8460143ae7407c381` | 6547 | Verified |
| `docs/briefs/P3.3.md` + `docs/reports/P3.3.md` | `Projects/OpsBridge AI/Phases/P3/P3.3 - Salesforce read-only test connection.md` | `700d9c6d5c1dadcde4659c795603d3a366ff0984a0b317da6604e85911b2e17b` | 6304 | Verified |
| `docs/briefs/P3.4.md` + `docs/reports/P3.4.md` | `Projects/OpsBridge AI/Phases/P3/P3.4 - Evidence-led reconciliation.md` | `50388ac4228e8de8c9b265cc00b248f723fa1f87d8d58308550b4726713283c0` | 6773 | Verified |
| `docs/briefs/P3.5.md` + `docs/reports/P3.5.md` | `Projects/OpsBridge AI/Phases/P3/P3.5 - Inventory and consultant integration slice.md` | `c25e0a9cca121dbf22e0b52da220b446a73f80694fca2ed615678daf003453d9` | 5991 | Verified |
| `docs/briefs/P3.6.md` + `docs/reports/P3.6.md` | `Projects/OpsBridge AI/Phases/P3/P3.6 - Failure recovery and integration gate.md` | `9179f59cfcc8e6cd96d2cab5019946cfc1def9e3ca23d22fc5015b38d4522e25` | 5672 | Verified |
| `docs/reports/P3.md` | `Projects/OpsBridge AI/Phases/P3/P3 - Phase review.md` | `86357fe186ccb8a96fc37662c031df4d446bf3de3d94b73625e77980d4a3442a` | 10531 | Verified |
| `docs/briefs/P4.md` | `Projects/OpsBridge AI/Phases/P4/P4 - Phase brief.md` | `8c8da4357b48d60167702876cd97a0a3fb39bb6c4c43309cc7b46f4613df89ab` | 6488 | Verified |
| `docs/briefs/P4.1.md` + `docs/reports/P4.1.md` | `Projects/OpsBridge AI/Phases/P4/P4.1 - Rules and simulated effects.md` | `edbbb063b385ac613a7a608ecc31cf573745de6f82703d4f1f021aeaf382958b` | 7895 | Verified |
| `docs/briefs/P4.2.md` + `docs/reports/P4.2.md` | `Projects/OpsBridge AI/Phases/P4/P4.2 - Durable dispatch and safe retries.md` | `8e4f8f165d2f27bf2a460b94f6e22be70472ec85abed114ad612e01f8f65c949` | 7966 | Verified |
| `docs/briefs/P4.3.md` + `docs/reports/P4.3.md` | `Projects/OpsBridge AI/Phases/P4/P4.3 - Approved Google Sheets and Zapier bridge.md` | `bb9441c51edfbd66c24dc9e4ee0a9cbfe5061aa07a9309e43a4a243c6be6c76c` | 6780 | Verified |
| `docs/briefs/P4.4.md` + `docs/reports/P4.4.md` | `Projects/OpsBridge AI/Phases/P4/P4.4 - Delivery evidence and operator controls.md` | `635efc73e2479b083f8425da2bae72a2378af422363e17fb83feee1403a08927` | 6299 | Verified |
| `docs/briefs/P4.5.md` + `docs/reports/P4.5.md` | `Projects/OpsBridge AI/Phases/P4/P4.5 - Automation failure and owner gate.md` | `0f075892e33de8ea01f4bc952773e7104979e28a34147719fd4441b05d24af34` | 5344 | Verified |
| `docs/reports/P4.md` | `Projects/OpsBridge AI/Phases/P4/P4 - Phase review.md` | `959d0d1cedaf7b055279040a81f3a064cbc73c213d0423c4b7dc94ca4de6f569` | 8045 | Verified |
| `docs/runbooks/AUTOMATION.md` | `Projects/OpsBridge AI/Phases/P4/Automation runbook.md` | `11c316d44bb11d4859c2b3b892460cd8ad1565962b2cfb994bbc7f58c3c5292a` | 6030 | Verified |
| `docs/briefs/P5.md` | `Projects/OpsBridge AI/Phases/P5/P5 - Phase brief.md` | `ca65ae93e88982b291dde1a7b79db262ef6ebd51c5ad25f8189f86e32c6b49a8` | 7312 | Verified |
| `docs/briefs/P5.1.md` + `docs/reports/P5.1.md` | `Projects/OpsBridge AI/Phases/P5/P5.1 - Fixture document lifecycle.md` | `1ab73f637ee6e6f31c213ebbb584044e1a0c494960fa9519d2143b35e86a1ed5` | 9013 | Verified |
| `docs/briefs/P5.2.md` + `docs/reports/P5.2.md` | `Projects/OpsBridge AI/Phases/P5/P5.2 - Structured fixture review.md` | `e9927afb197fe9604fa44891b9c4acc3328da861a3349fc42bb50f4fbf1e73ad` | 8727 | Verified |
| `docs/briefs/P5.3.md` + `docs/reports/P5.3.md` | `Projects/OpsBridge AI/Phases/P5/P5.3 - Owner-only live gateway and budgets.md` | `6611b0781de0f705738e044208fc49f3becc693e990dfca4a95a7cef723d419f` | 8631 | Verified |
| `docs/briefs/P5.4.md` + `docs/reports/P5.4.md` | `Projects/OpsBridge AI/Phases/P5/P5.4 - Human review and audited command.md` | `3f6ec66c585f23192a1ec8a595df7ee37239b4fb21c166827b49160ca11139f0` | 8142 | Verified |
| `docs/briefs/P5.5.md` + `docs/reports/P5.5.md` | `Projects/OpsBridge AI/Phases/P5/P5.5 - Evaluation and AI owner gate.md` | `9ec9b7e1fbd7ff9cf0e7234d816210b8cac3c24480e72f91b2ef388751dafb21` | 6176 | Verified |
| `docs/reports/P5.md` | `Projects/OpsBridge AI/Phases/P5/P5 - Phase review.md` | `848ab4477ef412acf5327a324a4a8f80fbbe7a1f87fbdb1b99520f8083b0479d` | 10496 | Verified |
| `docs/design/AI-PROVIDER-DATA.md` | `Projects/OpsBridge AI/Phases/P5/AI provider data handling.md` | `f0fabbcec179b7a94ee3be7a094a4b66a3258c7ec7ebe8d6c803a22f2395827f` | 2792 | Verified |
| `docs/briefs/P6.md` | `Projects/OpsBridge AI/Phases/P6/P6 - Phase brief.md` | `be45b38c15867546a628b93962b0d4244b700b4eea651958713391bdfc87f70b` | 6531 | Verified |
| `docs/runbooks/CONNECTORS.md` | `Projects/OpsBridge AI/Phases/P3/Connector runbook.md` | `5c9127ff95f617906f8d958184b4f91dc730e868e77b67ef45d3e283ee3df1d0` | 6931 | Verified |
| `docs/briefs/P6.1.md` + `docs/reports/P6.1.md` | `Projects/OpsBridge AI/Phases/P6/P6.1 - Metric definitions and scoped queries.md` | `7b741f1a331c802e11a7572e8907a5f23bf61ccad05a78d5d99a7c1f8c143e31` | 7591 | Verified |
| `docs/briefs/P6.2.md` + `docs/reports/P6.2.md` | `Projects/OpsBridge AI/Phases/P6/P6.2 - Operational dashboards.md` | `e194b641dd5c54bffbb583ba3056ad1da45bfe7958bc343cb7d8fee97a38aef6` | 6652 | Verified |
| `docs/briefs/P6.3.md` + `docs/reports/P6.3.md` | `Projects/OpsBridge AI/Phases/P6/P6.3 - Self-serve reports and safe export.md` | `527ac167768182f9cc7e22bd8795b7ea9697655958121267955f9cd27fce2281` | 7293 | Verified |
| `docs/briefs/P6.4.md` + `docs/reports/P6.4.md` | `Projects/OpsBridge AI/Phases/P6/P6.4 - ROI scenarios and sensitivity.md` | `99af47cf97a346140e5149b3771335528e68fd384515517f8a98ff4c66b17019` | 6207 | Verified |
| `docs/briefs/P6.5.md` + `docs/reports/P6.5.md` | `Projects/OpsBridge AI/Phases/P6/P6.5 - Executive business case and owner gate.md` | `36f3aedf7f59c8bb36fc455ce87656e23f6fbd7a4dfc7cc43ab37b325009f05f` | 5905 | Verified |
| `docs/reports/P6.md` | `Projects/OpsBridge AI/Phases/P6/P6 - Phase review.md` | `44341e77ccd1ac70f8f17021e8246f6fc48e59c25674a30ff395d677315b6ee6` | 10935 | Verified |
| `docs/design/METRICS.md` | `Projects/OpsBridge AI/Phases/P6/Metric specification.md` | `b963d7b6123b8447dc740ffc998d762deae3d2e3999ae95a48c7d4963455baf3` | 5843 | Verified |
| `docs/EXECUTIVE-BUSINESS-CASE.md` | `Projects/OpsBridge AI/Phases/P6/Executive business case.md` | `90c9de2bb67229823433f959390365957fc3fecf3d35cbda999d0c4ae01633c2` | 6430 | Verified |
| `docs/STAKEHOLDER-WALKTHROUGH-P6.md` | `Projects/OpsBridge AI/Phases/P6/Stakeholder walkthrough.md` | `ebeea26d3fa3c0592b80491caa150cd3b176bcb56b6a709ade066c385877c62f` | 4560 | Verified |
| `docs/briefs/P7.md` | `Projects/OpsBridge AI/Phases/P7/P7 - Phase brief.md` | `5ae8b378537d6a90d9bd51546523bd2659c35bdeb0d04d35858ed3b9d80508fc` | 5368 | Verified |

Package notes join the brief and report for that package, separated by a rule. The separate vault `Sync Manifest.md` holds this same table and is not listed in itself. PRD source of truth is the project `PRD.md`, and `OpsBridge_AI_Phased_PRD_v1.4.md` is byte-identical. See `docs/VAULT-WORKFLOW.md` for the procedure.
