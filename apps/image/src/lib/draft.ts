// 編集中の作品を IndexedDB に一時保存する（誤って再読み込みしても消えないように）。
// 画像が大きく sessionStorage には収まらないので IndexedDB を使い、タブごとの id（sessionStorage）で分ける。
// タブを閉じると id が消えて読めなくなるので、古い一時保存は次に開いたときに削除する。
import * as model from "./model";

const DB_NAME = "toolbox-image";
const DRAFTS = "drafts";
/** 画像は作品の JSON と分けて保存し、変わっていない画像を書き直さないようにする */
const ASSETS = "assets";
const SESSION_KEY = "toolbox:image:session";
/** これより長く更新のない一時保存は、閉じたタブのものとして削除する */
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;

type Entry = {
  updated: number;
  /** project.toJson の形の作品 */
  doc: string;
  /** 作品ファイルに保存していない変更があるか */
  dirty: boolean;
  /** 上書き保存先のファイル（File System Access API）。保存できないブラウザでは null */
  handle: unknown;
};

export type Draft = {
  doc: string;
  dirty: boolean;
  handle: unknown;
  assets: Map<string, Blob>;
};

const sessionId = () => {
  try {
    let id = sessionStorage.getItem(SESSION_KEY);
    if (!id) {
      id = model.newId();
      sessionStorage.setItem(SESSION_KEY, id);
    }
    return id;
  } catch {
    // sessionStorage が使えない環境では一時保存しない
    return null;
  }
};

let opening: Promise<IDBDatabase | null> | null = null;
const open = () => {
  opening ??= new Promise<IDBDatabase | null>((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, 1);
      request.addEventListener("upgradeneeded", () => {
        request.result.createObjectStore(DRAFTS);
        request.result.createObjectStore(ASSETS);
      });
      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () => resolve(null));
      request.addEventListener("blocked", () => resolve(null));
    } catch {
      resolve(null);
    }
  });
  return opening;
};

const done = (transaction: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("error", () => reject(transaction.error));
    transaction.addEventListener("abort", () => reject(transaction.error));
  });

const result = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });

/** このタブの画像のキー（[タブの id, 画像の id]） */
const assetRange = (session: string) =>
  IDBKeyRange.bound([session, ""], [session, "￿"]);

/** すでに書いた画像（このページを開いている間だけ覚える） */
const written = new Set<string>();

export const load = async (): Promise<Draft | null> => {
  const session = sessionId();
  const db = session ? await open() : null;
  if (!session || !db) return null;
  try {
    const transaction = db.transaction([DRAFTS, ASSETS], "readonly");
    const record = (await result(
      transaction.objectStore(DRAFTS).get(session),
    )) as Entry | undefined;
    if (!record || typeof record.doc !== "string") return null;
    const assets = new Map<string, Blob>();
    const store = transaction.objectStore(ASSETS);
    const keys = await result(store.getAllKeys(assetRange(session)));
    const values = await result(store.getAll(assetRange(session)));
    keys.forEach((key, index) => {
      const id = Array.isArray(key) ? key[1] : null;
      const blob = values[index] as unknown;
      if (typeof id === "string" && blob instanceof Blob) {
        assets.set(id, blob);
        written.add(id);
      }
    });
    return {
      doc: record.doc,
      dirty: record.dirty === true,
      handle: record.handle ?? null,
      assets,
    };
  } catch {
    return null;
  }
};

const saveNow = async (
  doc: string,
  dirty: boolean,
  handle: unknown,
  assets: model.Assets,
  used: ReadonlySet<string>,
) => {
  const session = sessionId();
  const db = session ? await open() : null;
  if (!session || !db) return;
  const write = async (keepHandle: boolean) => {
    const transaction = db.transaction([DRAFTS, ASSETS], "readwrite");
    const record: Entry = {
      updated: Date.now(),
      doc,
      dirty,
      handle: keepHandle ? handle : null,
    };
    transaction.objectStore(DRAFTS).put(record, session);
    const store = transaction.objectStore(ASSETS);
    for (const id of used) {
      const asset = assets.get(id);
      if (!asset || written.has(id)) continue;
      store.put(asset.blob, [session, id]);
    }
    // 使わなくなった画像は消す
    for (const id of written) if (!used.has(id)) store.delete([session, id]);
    await done(transaction);
  };
  try {
    await write(true);
  } catch {
    // ファイルの参照を保存できないブラウザでは、参照なしで保存する
    try {
      await write(false);
    } catch {
      return;
    }
  }
  for (const id of used) if (assets.has(id)) written.add(id);
  for (const id of written) if (!used.has(id)) written.delete(id);
};

let queue = Promise.resolve();
/** 一時保存する（前の保存が終わってから順に書く） */
export const save = (...args: Parameters<typeof saveNow>) => {
  queue = queue.then(() => saveNow(...args));
  return queue;
};

/** 閉じたタブの古い一時保存を消す */
export const purge = async () => {
  const session = sessionId();
  const db = await open();
  if (!db) return;
  try {
    const transaction = db.transaction([DRAFTS, ASSETS], "readwrite");
    const drafts = transaction.objectStore(DRAFTS);
    const keys = await result(drafts.getAllKeys());
    const records = await result(drafts.getAll());
    const now = Date.now();
    keys.forEach((key, index) => {
      const record = records[index] as Partial<Entry> | undefined;
      if (key === session || typeof key !== "string") return;
      if (now - (record?.updated ?? 0) < MAX_AGE) return;
      drafts.delete(key);
      transaction.objectStore(ASSETS).delete(assetRange(key));
    });
    await done(transaction);
  } catch {
    // 消せなくても、そのまま使える
  }
};
