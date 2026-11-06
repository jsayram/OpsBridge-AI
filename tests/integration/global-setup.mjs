import { localUrl, migrate, seed, setupLocal } from "../../scripts/db.mjs";

export default async function setup() {
  await setupLocal("opsbridge_test", { recreate: true });
  const url = localUrl("opsbridge_migrator", "opsbridge_test");
  await migrate(url);
  await seed(url);
}
