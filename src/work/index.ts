import dotenv from "dotenv";
dotenv.config();

import { createWorkApp } from "./app";

const port = Number(process.env.PORT ?? 8081);
const app = createWorkApp();

app.listen(port, () => {
  console.log(`Work service started on port ${port}`);
  console.log(`Health: http://0.0.0.0:${port}/health`);
  console.log(`Ready: http://0.0.0.0:${port}/ready`);
  console.log(`Work items: http://0.0.0.0:${port}/work-items`);
});
