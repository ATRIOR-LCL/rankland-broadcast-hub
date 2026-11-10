import { MigrationInterface, QueryRunner } from 'typeorm';

export class ClipSchema1793604932596 implements MigrationInterface {
  name = 'ClipSchema1793604932596';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "clip_task" ("task_id" varchar(36) PRIMARY KEY NOT NULL, "uca" varchar(128) NOT NULL, "user_id" varchar(128) NOT NULL, "source" varchar(16) NOT NULL, "title" varchar(200) NOT NULL, "category" varchar(32) NOT NULL, "tags" text NOT NULL, "priority" varchar(16) NOT NULL, "start_server_ms" integer NOT NULL, "end_server_ms" integer NOT NULL, "status" varchar(32) NOT NULL, "progress" real NOT NULL DEFAULT (0), "max_attempts" integer NOT NULL, "error_code" varchar(64), "error_message" varchar(500), "idempotency_key" varchar(200), "expires_at" integer NOT NULL, "created_at" integer NOT NULL, "updated_at" integer NOT NULL)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_clip_task_idempotency" ON "clip_task" ("uca", "idempotency_key") WHERE idempotency_key IS NOT NULL`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_clip_task_uca_created" ON "clip_task" ("uca", "created_at") `);
    await queryRunner.query(
      `CREATE TABLE "clip_task_item" ("item_id" varchar(36) PRIMARY KEY NOT NULL, "uca" varchar(128) NOT NULL, "task_id" varchar(36) NOT NULL, "user_id" varchar(128) NOT NULL, "track_id" varchar(128) NOT NULL, "status" varchar(32) NOT NULL, "progress" real NOT NULL DEFAULT (0), "error_code" varchar(64), "error_message" varchar(500), "attempts" integer NOT NULL DEFAULT (0), "generation" integer NOT NULL DEFAULT (0), "token_hash" varchar(64), "token_expires_at" integer, "next_attempt_at" integer, "actual_start_server_ms" integer, "actual_end_server_ms" integer, "created_at" integer NOT NULL, "updated_at" integer NOT NULL)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_clip_task_item_schedule" ON "clip_task_item" ("status", "next_attempt_at") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_clip_task_item_task_track" ON "clip_task_item" ("task_id", "track_id") `,
    );
    await queryRunner.query(
      `CREATE TABLE "clip_upload" ("upload_id" varchar(36) PRIMARY KEY NOT NULL, "uca" varchar(128) NOT NULL, "task_id" varchar(36) NOT NULL, "item_id" varchar(36) NOT NULL, "generation" integer NOT NULL, "role" varchar(16) NOT NULL, "status" varchar(16) NOT NULL, "file_name" varchar(255) NOT NULL, "mime_type" varchar(32) NOT NULL, "upload_length" integer NOT NULL, "checksum_sha256" varchar(64) NOT NULL, "upload_offset" integer NOT NULL DEFAULT (0), "complete_payload" text, "clip_id" varchar(36), "expires_at" integer NOT NULL, "created_at" integer NOT NULL, "updated_at" integer NOT NULL)`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_clip_upload_status" ON "clip_upload" ("status", "expires_at") `);
    await queryRunner.query(`CREATE INDEX "IDX_clip_upload_item" ON "clip_upload" ("item_id", "generation", "role") `);
    await queryRunner.query(
      `CREATE TABLE "clip" ("clip_id" varchar(36) PRIMARY KEY NOT NULL, "uca" varchar(128) NOT NULL, "task_id" varchar(36) NOT NULL, "item_id" varchar(36) NOT NULL, "user_id" varchar(128) NOT NULL, "track_id" varchar(128) NOT NULL, "source" varchar(16) NOT NULL, "category" varchar(32) NOT NULL, "title" varchar(200) NOT NULL, "tags" text NOT NULL, "media_path" varchar(512) NOT NULL, "thumbnail_path" varchar(512), "thumbnail_mime_type" varchar(32), "mime_type" varchar(32) NOT NULL, "byte_size" integer NOT NULL, "duration_ms" integer NOT NULL, "width" integer, "height" integer, "video_codec" varchar(32), "audio_codec" varchar(32), "checksum_sha256" varchar(64) NOT NULL, "actual_start_server_ms" integer NOT NULL, "actual_end_server_ms" integer NOT NULL, "status" varchar(16) NOT NULL, "files_removed" boolean NOT NULL DEFAULT (0), "expires_at" integer NOT NULL, "created_at" integer NOT NULL, "deleted_at" integer)`,
    );
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_clip_item" ON "clip" ("item_id") `);
    await queryRunner.query(`CREATE INDEX "IDX_clip_uca_status_created" ON "clip" ("uca", "status", "created_at") `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_clip_uca_status_created"`);
    await queryRunner.query(`DROP INDEX "IDX_clip_item"`);
    await queryRunner.query(`DROP TABLE "clip"`);
    await queryRunner.query(`DROP INDEX "IDX_clip_upload_item"`);
    await queryRunner.query(`DROP INDEX "IDX_clip_upload_status"`);
    await queryRunner.query(`DROP TABLE "clip_upload"`);
    await queryRunner.query(`DROP INDEX "IDX_clip_task_item_task_track"`);
    await queryRunner.query(`DROP INDEX "IDX_clip_task_item_schedule"`);
    await queryRunner.query(`DROP TABLE "clip_task_item"`);
    await queryRunner.query(`DROP INDEX "IDX_clip_task_uca_created"`);
    await queryRunner.query(`DROP INDEX "IDX_clip_task_idempotency"`);
    await queryRunner.query(`DROP TABLE "clip_task"`);
  }
}
