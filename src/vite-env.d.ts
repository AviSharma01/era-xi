declare module "*.css";
declare module "*.json?raw" {
  const value: string;
  export default value;
}
