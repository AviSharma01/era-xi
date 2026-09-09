/// <reference types="vite/client" />

declare module "*.css";
declare module "*.json?raw" {
  const value: string;
  export default value;
}
