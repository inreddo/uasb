# UASB engine

> **Status: archived, for reference only.**
> This project has merged with another simulator that is in active operation, and development of this project's own engine and cards has stopped.
> The card effects were still being developed and tested, and many bugs are known to remain.

UASB (UA Sim : BATTLE!): the rules engine and card-effect implementation for UNION ARENA. This repository holds the final engine, compiler and card code with the card data they load. It contains no card images or other assets, and no client, server, tests or documents.

## Layout

| Path | Contents |
|---|---|
| `packages/engine/src` | Rules engine: zones and phases, effects, conditions, triggers, choices, deck rules, player views |
| `packages/cards/src` | Effect compiler (`compile.ts`) and the card catalogs built from the data |
| `packages/cards/data` | Card data: compiled catalogs, printings, card library, AP cards |
| `examples` | Sample cards and a policy; `demo.ts` plays a game |

## Use

Requires Node.js 22 or later.

```
npm install
npm run typecheck
npm run demo
```
