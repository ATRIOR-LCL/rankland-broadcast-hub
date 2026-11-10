import fs from 'fs';
import path from 'path';
import { Inject, Provide } from 'bwcx-core';
import { DataSource } from 'typeorm';
import SqliteConfig from '@server/configs/sqlite/sqlite.config';
import { createSqliteDataSource } from './typeorm-data-source';

@Provide()
export default class TypeOrmClient {
  private readonly dataSource: DataSource;

  public constructor(@Inject(SqliteConfig) private readonly sqliteConfig: SqliteConfig) {
    this.dataSource = createSqliteDataSource(sqliteConfig);
  }

  public async init(): Promise<DataSource> {
    if (!this.dataSource.isInitialized) {
      // sqlite 不会自动创建数据库所在目录
      await fs.promises.mkdir(path.dirname(this.sqliteConfig.database), { recursive: true });
      await this.dataSource.initialize();
    }
    return this.dataSource;
  }

  public getDataSource(): DataSource {
    return this.dataSource;
  }

  public async destroy(): Promise<void> {
    if (this.dataSource.isInitialized) {
      await this.dataSource.destroy();
    }
  }
}
