import { app } from "electron";
import { join } from "node:path";
import { openDatabase } from "./database";
import { migrateJsonStore } from "./storage-migration";
import { createSettingsRepository } from "./repositories";

const userDataDir = app.getPath("userData");
export const database = openDatabase(join(userDataDir, "mediaget.sqlite"));
export const migrationReport = migrateJsonStore({ userDataDir, db: database });
export const settingsRepository = createSettingsRepository(database);
