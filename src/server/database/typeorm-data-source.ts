import path from 'path';
import { DataSource, DataSourceOptions } from 'typeorm';
import type SqliteConfig from '../configs/sqlite/sqlite.config';
import { ClipTaskEntity } from '../entities/clip-task.entity';
import { ClipTaskItemEntity } from '../entities/clip-task-item.entity';
import { ClipUploadEntity } from '../entities/clip-upload.entity';
import { ClipEntity } from '../entities/clip.entity';

export type SqliteDataSourceConfig = Pick<SqliteConfig, 'database'>;

export function getSqliteDataSourceOptions(sqliteConfig: SqliteDataSourceConfig): DataSourceOptions {
  return {
    type: 'sqlite',
    database: sqliteConfig.database,
    enableWAL: true,
    synchronize: false,
    migrationsRun: false,
    entities: [ClipTaskEntity, ClipTaskItemEntity, ClipUploadEntity, ClipEntity],
    migrations: [path.join(__dirname, 'migrations/*{.ts,.js}')],
    migrationsTableName: 'typeorm_migrations',
  };
}

export function createSqliteDataSource(sqliteConfig: SqliteDataSourceConfig): DataSource {
  return new DataSource(getSqliteDataSourceOptions(sqliteConfig));
}
