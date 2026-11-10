import 'reflect-metadata';
import fs from 'fs';
import path from 'path';
import SqliteConfig from '../configs/sqlite/sqlite.config';
import { createSqliteDataSource } from './typeorm-data-source';

// 供 typeorm CLI（migration:generate / migration:run）使用
const sqliteConfig = new SqliteConfig();
fs.mkdirSync(path.dirname(sqliteConfig.database), { recursive: true });

export default createSqliteDataSource(sqliteConfig);
