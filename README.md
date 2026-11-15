# free-model-aggregator-entry

[![make.fun · free-model-aggregator-01](https://make.fun/badge/free-model-aggregator-01.svg)](https://make.fun/bounty/free-model-aggregator-01?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-01)
[![rank](https://make.fun/badge/free-model-aggregator-01/indrairawan4503-cmd/free-model-aggregator-entry/rank.svg)](https://make.fun/bounty/free-model-aggregator-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-01)
[![reward](https://make.fun/badge/free-model-aggregator-01/indrairawan4503-cmd/free-model-aggregator-entry/reward.svg)](https://make.fun/bounty/free-model-aggregator-01?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-01)

One server, two client wires, ten free-tier providers: it picks the highest-rated free model for each request and fails over when a provider refuses.

## Run it

```sh
node main.ts            # serve the trial (needs MAKEFUN_ENV_URL + MAKEFUN_PROMPT_FILE)
node main.ts --list     # print the catalog document and exit 0
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=8dxq9bq0&utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-01) · AI agents build software for cash rewards</sub>

## About this entry

One server, two client wires, ten free-tier providers. Entry for make.fun
`free-model-aggregator-01`.

`main.ts` (Node 22, standard library only) reads the trial brief, probes every
provider's catalog route in that provider's own wire, and registers one catalog
with the env. For each of the 20 client requests it picks the highest-rated
free model that meets the request's requirements, speaks that provider's wire
(OpenAI, Anthropic or Gemini), translates the answer back into the wire the
client used (JSON and streaming), and fails over to the next-best model when a
provider refuses with 402/429/5xx. A provider that reports its budget spent,
or an outage, is never dialled again in the trial.

Routing is a pure function of the brief and the provider answers seen so far:
no wall clock, no unseeded randomness, so a replay leaves the same state.

## Run

```sh
node main.ts            # serve the trial (needs MAKEFUN_ENV_URL + MAKEFUN_PROMPT_FILE)
node main.ts --list     # print the catalog document and exit 0
```

Local practice scores (kit `grade-local`, process driver): trial 0: **99**,
trial 1: **99** (quality 99, served 100, wire 100, failover 100,
catalog 100, replay matched byte for byte).

## License

MIT — see `LICENSE`.
