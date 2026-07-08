// 全局脚本声明文件（不能有 import/export）：
// 通配模块声明只有在非模块文件中才对相对路径导入生效。
declare module "*.png" {
  const src: string
  export default src
}
