import fs from "fs";
import fsp from "fs/promises";
import pLimit from "p-limit";
import chalk from "chalk";
import { ProxyAgent } from "undici";

const ENDPOINT = "https://api.atomicmail.io/v1/auth/sign-up/check";

const CONCURRENCY = 5;
const REQUEST_TIMEOUT_MS = 15000;
const BASE_DELAY_MS = 120;

const MIN_LEN = 3; // passend zu deinem "min" error bei "ss"

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function parseList(raw) {
  return raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
}

function normalizeProxy(line) {
  if (!line) return null;
  if (/^https?:\/\//i.test(line)) return line;
  if (/^[\w.\-]+:\d+$/.test(line)) return `http://${line}`;
  return `http://${line}`;
}

function isProxyError(err) {
  const msg = String(err?.message || err);
  return (
    msg.includes("ECONNRESET") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("ENOTFOUND") ||
    msg.includes("EAI_AGAIN") ||
    msg.includes("socket") ||
    msg.includes("407") ||
    msg.includes("fetch failed") ||
    msg.includes("aborted")
  );
}

async function fetchCheck(username, proxyUrl) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;

    return await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username }),
      dispatcher,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(t);
  }
}

function createProxyRotator(proxies) {
  let i = 0;
  return {
    current() {
      return proxies.length ? proxies[i % proxies.length] : null;
    },
    next() {
      i++;
      return proxies.length ? proxies[i % proxies.length] : null;
    },
  };
}

async function safeReadBody(res) {
  // try json first, fallback text
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    const j = await res.json().catch(() => null);
    if (j) return JSON.stringify(j);
  }
  return await res.text().catch(() => "");
}

async function checkUsername(username, rotator, maxTries) {
  // local filter
  if (username.length < MIN_LEN) {
    return { username, status: "invalid", detail: `min_length_${MIN_LEN}` };
  }

  for (let attempt = 0; attempt < maxTries; attempt++) {
    const proxy = rotator.current();

    try {
      const res = await fetchCheck(username, proxy);

      if (res.ok) return { username, status: "available" };
      if (res.status === 409) return { username, status: "taken" };

      if (res.status === 429) {
        rotator.next();
        await sleep(250);
        continue;
      }

      if (res.status === 400) {
        // invalid / blocked / reserved -> proxy won't fix this
        const body = await safeReadBody(res);
        return { username, status: "invalid", code: 400, detail: body.slice(0, 200) };
      }

      // other errors
      const body = await safeReadBody(res);

      // rotate once on weird status
      rotator.next();

      // retry on 5xx, otherwise stop
      if (res.status >= 500 && res.status <= 599) {
        await sleep(200);
        continue;
      }

      return { username, status: "error", code: res.status, detail: body.slice(0, 200) };

    } catch (err) {
      if (isProxyError(err)) {
        rotator.next();
        await sleep(200);
        continue;
      }
      return { username, status: "error", detail: String(err).slice(0, 200) };
    } finally {
      await sleep(BASE_DELAY_MS);
    }
  }

  return { username, status: "error", detail: "retry limit reached" };
}

function clearConsole() {
  process.stdout.write("\x1Bc");
}

const frames = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];
function startTitle(state) {
  let i = 0;
  return setInterval(() => {
    process.title =
      `AtomicMail Username Checker by coazy ${frames[i++ % frames.length]} | ` +
      `Usernames loaded: ${state.total} | ` +
      `Available: ${state.available} | ` +
      `Taken: ${state.taken}`;
  }, 120);
}

async function run() {
  const usernamesRaw = await fsp.readFile("usernames.txt", "utf8");
  const proxiesRaw = await fsp.readFile("proxies.txt", "utf8").catch(() => "");

  const usernames = parseList(usernamesRaw);
  const proxies = parseList(proxiesRaw).map(normalizeProxy).filter(Boolean);

  if (!usernames.length) {
    console.log("usernames.txt is empty");
    return;
  }

  // reset
  fs.writeFileSync("available.txt", "");
  fs.writeFileSync("taken.txt", "");
  fs.writeFileSync("invalid.txt", "");
  fs.writeFileSync("errors.txt", "");

  const availableStream = fs.createWriteStream("available.txt", { flags: "a" });
  const takenStream = fs.createWriteStream("taken.txt", { flags: "a" });
  const invalidStream = fs.createWriteStream("invalid.txt", { flags: "a" });
  const errorStream = fs.createWriteStream("errors.txt", { flags: "a" });

  const rotator = createProxyRotator(proxies);
  const limit = pLimit(CONCURRENCY);
  const maxTries = Math.max(3, proxies.length ? proxies.length * 2 : 3);

  const state = { total: usernames.length, available: 0, taken: 0 };
  const titleTimer = startTitle(state);

  const availableList = [];
  const takenList = [];
  const invalidList = [];
  const errorList = [];

  clearConsole();
  console.log(chalk.cyan.bold("AtomicMail Checker by coazy"));
  console.log(chalk.gray(`Usernames: ${usernames.length} | Proxies: ${proxies.length} | Concurrency: ${CONCURRENCY}\n`));

  await Promise.all(
    usernames.map(name =>
      limit(async () => {
        const r = await checkUsername(name, rotator, maxTries);

        if (r.status === "available") {
          state.available++;
          availableList.push(name);
          availableStream.write(name + "\n");
          console.log(chalk.green("[+] Available:"), name);
          return;
        }

        if (r.status === "taken") {
          state.taken++;
          takenList.push(name);
          takenStream.write(name + "\n");
          console.log(chalk.hex("#ff7a7a")("[-] Taken:"), name);
          return;
        }

        if (r.status === "invalid") {
          invalidList.push(r);
          invalidStream.write(`${name} | ${r.detail ?? ""}\n`);
          console.log(chalk.gray("[!] Invalid:"), name);
          return;
        }

        errorList.push(r);
        errorStream.write(`${name} | ${r.code ?? ""} | ${r.detail ?? ""}\n`);
        console.log(chalk.yellow("[~] Error:"), name);
      })
    )
  );

  clearInterval(titleTimer);

  await new Promise(r => availableStream.end(r));
  await new Promise(r => takenStream.end(r));
  await new Promise(r => invalidStream.end(r));
  await new Promise(r => errorStream.end(r));

  clearConsole();
  console.log(chalk.cyan.bold("AtomicMail Checker by coazy"));
  console.log(chalk.gray("====================================="));
  console.log(chalk.green(`Available: ${state.available}`));
  console.log(chalk.hex("#ff7a7a")(`Taken:     ${state.taken}`));
  console.log(chalk.gray(`Invalid:   ${invalidList.length}`));
  console.log(chalk.yellow(`Errors:    ${errorList.length}`));
  console.log(chalk.gray("=====================================\n"));

  console.log(chalk.gray("saved to available.txt / taken.txt / invalid.txt / errors.txt"));
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
