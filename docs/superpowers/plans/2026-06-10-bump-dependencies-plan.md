# Update package.json Dependencies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update specific dependencies in `package.json` to their latest versions and reflect those changes in `package-lock.json`.

**Architecture:** Modify the `package.json` file using an exact string replace to target the outdated version strings for `@opencode-ai/plugin`, `@opencode-ai/sdk`, `@types/node`, and `typescript`. Then, execute `npm install` to finalize the `package-lock.json` and build the plugin to verify nothing was broken by the update.

**Tech Stack:** npm, Node.js

---

### Task 1: Update package.json Dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Update devDependencies versions**

```bash
# Update @opencode-ai/sdk, @types/node, and typescript in devDependencies
sed -i 's/"@opencode-ai\/sdk": "\^1.15.6"/"@opencode-ai\/sdk": "\^1.17.0"/' package.json
sed -i 's/"@types\/node": "\^20.11.0"/"@types\/node": "\^25.9.2"/' package.json
sed -i 's/"typescript": "\^5.3.3"/"typescript": "\^6.0.3"/' package.json
```

- [ ] **Step 2: Update dependencies versions**

```bash
# Update @opencode-ai/plugin in dependencies
sed -i 's/"@opencode-ai\/plugin": "\^1.2.20"/"@opencode-ai\/plugin": "\^1.17.0"/' package.json
```

- [ ] **Step 3: Run npm install**

```bash
npm install
```

- [ ] **Step 4: Verify build succeeds**

Run: `npm run build`
Expected: Output showing the build succeeded without typescript errors.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: bump dependencies to latest versions" -m "Assisted-by: Gemini 3.1 Pro"
```
