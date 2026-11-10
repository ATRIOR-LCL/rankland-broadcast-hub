import path from 'path';
import { Config } from 'bwcx-ljsm';

@Config()
export default class SqliteConfig {
  public readonly database: string = path.resolve(
    process.env.CLIP_SQLITE_PATH ||
      path.join(process.env.CLIP_STORAGE_DIR || './data/highlight-replay', 'clips.sqlite'),
  );
}
