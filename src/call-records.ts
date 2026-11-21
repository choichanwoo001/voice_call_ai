import { lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { recordRetentionDays, type CallRecord, type CallRecordSummary } from "./contracts.ts";

export const recordRetentionMs = recordRetentionDays * 24 * 60 * 60 * 1000;
export const recordCleanupIntervalMs = 60_000;

const idPattern = "[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}";
const recordId = new RegExp(`^${idPattern}$`);
const recordFilename = new RegExp(`^(${idPattern})\\.json(\\.tmp)?$`);

function isMissing(error: unknown) {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

export function createCallRecords(directory: string, now = Date.now, remove: (path: string) => Promise<void> = unlink) {
  const writing = new Set<string>();
  const expired = (endedAt: number) => now() >= endedAt + recordRetentionMs;

  async function files() {
    try {
      return (await readdir(directory, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && recordFilename.test(entry.name));
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }

  async function read(filename: string, id: string): Promise<CallRecord | undefined> {
    try {
      const path = join(directory, filename);
      if (!(await lstat(path)).isFile()) return;
      const data = JSON.parse(await readFile(path, "utf8"));
      if (data?.id === id && typeof data.endedAt === "string" && Number.isFinite(Date.parse(data.endedAt))) {
        return data;
      }
    } catch (error) {
      if (!isMissing(error) && !(error instanceof SyntaxError)) throw error;
    }
  }

  async function get(id: string) {
    if (!recordId.test(id)) return;
    const record = await read(id + ".json", id);
    if (record && !expired(Date.parse(record.endedAt))) return record;
  }

  async function deleteFile(path: string) {
    try {
      await remove(path);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  return {
    get,
    async list(): Promise<CallRecordSummary[]> {
      const records: CallRecordSummary[] = [];
      for (const file of await files()) {
        const [, id, temporary] = recordFilename.exec(file.name)!;
        if (temporary) continue;
        const record = await get(id);
        if (record) records.push({
          id, endedAt: record.endedAt, department: record.decision?.department, outcome: record.handoff?.outcome,
        });
      }
      const cutoff = now() - recordRetentionMs;
      return records.filter((record) => Date.parse(record.endedAt) > cutoff)
        .sort((left, right) => Date.parse(right.endedAt) - Date.parse(left.endedAt));
    },
    async save(record: CallRecord) {
      const { id } = record;
      if (!recordId.test(id)) throw new Error("통화 기록 ID가 올바르지 않습니다.");
      const endedAt = Date.parse(record.endedAt);
      if (expired(endedAt)) return;
      writing.add(id);
      try {
        const file = join(directory, id + ".json");
        const temporary = file + ".tmp";
        await mkdir(directory, { recursive: true });
        await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
        if (expired(endedAt)) {
          await deleteFile(temporary);
          return;
        }
        await rename(temporary, file);
        if (!expired(endedAt)) return record;
      } finally {
        writing.delete(id);
      }
    },
    async purgeExpired() {
      let failures = 0;
      for (const file of await files()) {
        const [, id, temporary] = recordFilename.exec(file.name)!;
        if (writing.has(id)) continue;
        const path = join(directory, file.name);
        try {
          const record = await read(file.name, id);
          if (!record && temporary && !writing.has(id)) {
            await deleteFile(path);
            continue;
          }
          const endedAt = record ? Date.parse(record.endedAt) : (await lstat(path)).mtimeMs;
          if (expired(endedAt) && !writing.has(id)) await deleteFile(path);
        } catch (error) {
          if (!isMissing(error)) failures++;
        }
      }
      return failures;
    },
  };
}
