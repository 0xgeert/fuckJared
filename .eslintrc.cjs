/* eslint-env node */
module.exports = {
  root: true,
  extends: ["eslint:recommended", "prettier"],
  parserOptions: {
    ecmaVersion: "latest",
  },
  env: {
    node: true,
    es2020: true,
  },
  rules: {
    "no-unused-vars": "warn",
    "no-debugger": "warn",
  },
}
