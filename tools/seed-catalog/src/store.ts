/**
 * The filesystem side of the harvest: JSONL out, resume state beside it.
 *
 * Split from `harvest.ts` so the harvest can be tested against an in-memory store. A
 * test that has to create temp directories to check resume logic ends up testing the
 * temp directories.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { HarvestState, Store } from './harvest.js'
import { toLine, type SeedRow } from './row.js'

export class FileStore implements Store {
  constructor(
    private readonly rowsPath: string,
    private readonly statePath: string,
  ) {}

  async readState(): Promise<HarvestState | null> {
    const text = await this.#readIfPresent(this.statePath)
    return text === null ? null : (JSON.parse(text) as HarvestState)
  }

  async writeState(state: HarvestState): Promise<void> {
    await this.#write(this.statePath, `${JSON.stringify(state, null, 2)}\n`)
  }

  async clearState(): Promise<void> {
    await rm(this.statePath, { force: true })
  }

  async readRows(): Promise<SeedRow[]> {
    const text = await this.#readIfPresent(this.rowsPath)
    if (text === null) return []
    return text
      .split('\n')
      .filter(line => line.trim() !== '')
      .map(line => JSON.parse(line) as SeedRow)
  }

  async writeRows(rows: readonly SeedRow[]): Promise<void> {
    const body = rows.map(toLine).join('\n')
    await this.#write(this.rowsPath, rows.length === 0 ? '' : `${body}\n`)
  }

  async #readIfPresent(path: string): Promise<string | null> {
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async #write(path: string, body: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    // Explicit \n throughout and never the platform separator: this file is committed,
    // and `make verify` rejects CRLF because span offsets move when line endings change.
    await writeFile(path, body, { encoding: 'utf8' })
  }
}
