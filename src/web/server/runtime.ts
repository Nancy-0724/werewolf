import { Pool } from "pg";
import { DurableGameService } from "../../core/application/durableGameService.js";
import { InMemoryDurableGameStore } from "../../core/infrastructure/durableMemoryStore.js";
import { NodeCryptoRandom, SystemClock, UuidPort } from "../../core/infrastructure/nodeAdapters.js";
import { createPgDatabasePortFromPool } from "../../core/infrastructure/pgPoolAdapter.js";
import { PostgresGameStore } from "../../core/infrastructure/postgresGameStore.js";
import type { DurableGameStore } from "../../core/persistence/contracts.js";
import { PlayerViewService } from "../../projection/playerView.js";
import { InMemoryNpcCognitiveStore } from "../../npc/persistence/memoryStore.js";
import { PostgresNpcCognitiveStore } from "../../npc/persistence/postgresStore.js";
import { NpcCognitiveStateService } from "../../npc/persistence/service.js";
import type { NpcCognitiveStore } from "../../npc/persistence/contracts.js";

export type WebStorageMode = "POSTGRES" | "MEMORY_DEMO";

interface WebRuntime {
  store: DurableGameStore;
  gameService: DurableGameService;
  playerViewService: PlayerViewService;
  cognitiveStateService: NpcCognitiveStateService;
  storageMode: WebStorageMode;
}

declare global {
  var __werewolfMemoryStore: InMemoryDurableGameStore | undefined;
  var __werewolfPgPool: Pool | undefined;
  var __werewolfNpcMemoryStore: InMemoryNpcCognitiveStore | undefined;
  var __werewolfWebRuntime: WebRuntime | undefined;
}

function makeStores(): { store: DurableGameStore; cognitiveStore: NpcCognitiveStore; mode: WebStorageMode } {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (connectionString) {
    const pool = globalThis.__werewolfPgPool ?? new Pool({ connectionString, max: 5 });
    globalThis.__werewolfPgPool = pool;
    const db = createPgDatabasePortFromPool(pool);
    return { store: new PostgresGameStore(db), cognitiveStore: new PostgresNpcCognitiveStore(db), mode: "POSTGRES" };
  }
  if (process.env.NODE_ENV === "production" && process.env.WEB_ALLOW_MEMORY_DEMO !== "1") {
    throw new Error("DATABASE_URL is required in production. Set WEB_ALLOW_MEMORY_DEMO=1 only for disposable demos.");
  }
  const memory = globalThis.__werewolfMemoryStore ?? new InMemoryDurableGameStore();
  const cognitiveMemory = globalThis.__werewolfNpcMemoryStore ?? new InMemoryNpcCognitiveStore();
  globalThis.__werewolfMemoryStore = memory;
  globalThis.__werewolfNpcMemoryStore = cognitiveMemory;
  return { store: memory, cognitiveStore: cognitiveMemory, mode: "MEMORY_DEMO" };
}

export function getWebRuntime(): WebRuntime {
  if (globalThis.__werewolfWebRuntime) return globalThis.__werewolfWebRuntime;
  const { store, cognitiveStore, mode } = makeStores();
  const random = new NodeCryptoRandom();
  const clock = new SystemClock();
  const ids = new UuidPort();
  const gameService = new DurableGameService({
    store,
    random,
    clock,
    ids,
    engineBuildId: "werewolf-c03-0.10.0",
    snapshotEveryEvents: 50,
  });
  const runtime: WebRuntime = {
    store,
    gameService,
    playerViewService: new PlayerViewService(store),
    cognitiveStateService: new NpcCognitiveStateService(cognitiveStore),
    storageMode: mode,
  };
  globalThis.__werewolfWebRuntime = runtime;
  return runtime;
}
