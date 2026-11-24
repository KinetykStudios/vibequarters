// No text a figure's transcript holds can stall the server. Every regex the desk screens use (the secret cuts, the
// result parsers on the server, the page-text parser in the page) is fed crafted 16 KB inputs: its own name characters
// and keywords repeated with no terminator, and the inputs listed below. Each must finish in under 100 ms (the best of
// 3 runs, and of up to 10 more when those are over it: helpers.js bestMs), and so must cutSecrets, screenLines, the
// page-text parser and a whole screen.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as page from "../public/floor/screens.js";

const require = createRequire(import.meta.url);
const { cutSecrets, screenLines, SCREEN_RES } = require("../lib/describe.js");
const { newScreens, foldScreen, screenOf, SCREEN_PARSERS } = require("../lib/session.js");
const { PAGE_RES, pageItems } = page;
const { at, asst, tool, bestMs } = require("./helpers.js");

const N = 16384, LIMIT = process.env.CI ? 400 : 100; // CI: shared, slow machines
const fill = (unit, n = N) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
const pad = (head, unit) => head + fill(unit, N - head.length);
const ESC = String.fromCharCode(27), ZW = String.fromCharCode(0x200b), NUL = String.fromCharCode(0);
// inputs fed to every regex
const LISTED = [
  "key-".repeat(4096),
  "--" + "token-".repeat(2731),
  "a".repeat(16384),
  "https://" + "a:".repeat(8000),
  "-----BEGIN PRIV" + "ATE KEY-----" + "A".repeat(16000),
  pad('- textbox "', "pass"),
  fill("[Screenshot of "),
  fill("- [Screenshot of "),
];
// a named value's other separators and quotes: URL-encoded, HTML, JSON escapes, full width, triple quotes, and a value
// after a "[hidden]"
const FW = String.fromCharCode(0xff1a), SHY = String.fromCharCode(0xad);
const NAMED_MORE = [fill("password%3A"), fill("%22password%22%3A%22"), pad("password%3D", "a"), pad("token%3D", "%2"), fill("a%3D"), fill("password&#61;"), fill("&#58;"),
  fill("a\\u003a"), fill("password\\u003"), fill("password" + FW), pad('password = """', "a"), fill('"""'), fill("'''a"), pad("password=", "[hidden]"), fill("password=[hidden]"),
  fill("%27"), fill("pass" + SHY), fill("password=\\a"), pad("password=", "\\"), fill("pass=\\'")];
// each regex's own inputs, by the name its module exports it under
const OWN = {
  auth: [fill("authorization"), pad("authorization", " "), pad("proxy-authorization", " \t"), fill('authorization "')],
  cookie: [fill("cookie "), pad("set-cookie", " "), fill("cookie\"")],
  privateKey: [pad("-----BEGIN ", "A "), fill("-----BEGIN "), fill("-----BEGIN PRIV" + "ATE KEY-----"), pad("-----BEGIN RSA PRIV" + "ATE KEY-----\n", "-----END "), pad("-----BEGIN PGP PRIV" + "ATE KEY BLOCK-----", "a\n"), pad("-----BEGIN PRIV" + "ATE KEY-----", "\n")],
  stripe: [fill("sk_live_"), fill("pk_test_a"), fill(" rk_live_aaaaaaa")],
  openai: [fill("sk-"), pad("sk-", "a"), fill(" sk-aaaaaaa")],
  github: [fill("ghp_"), fill("github_pat_"), fill(" ghp_aaaa")],
  slack: [fill("xoxb-"), fill(" xoxp-a")],
  awsKeyId: [fill("AKIA"), pad("ASIA", "A"), fill(" AKIAAAAA")],
  google: [fill("AIza"), fill(" AIza-")],
  jwt: [fill("eyJ-"), fill("-eyJ"), pad("eyJ", "a"), fill("eyJaaaaaaaaaa."), fill(" eyJaaaaaaaa.aaaaaaaa"), fill(".eyJaaaaaaaaa"), fill("-eyJaaaaaaaa."), pad("-eyJaaaaaaaa.", "-eyJ"), pad("-eyJ".repeat(250) + "aaaaaaaa.", "a-"), fill("eyJaaaaaaaa." + "a".repeat(5000) + ".")],
  prefixed: [fill("npm_"), fill("sb_secret_"), fill(" hf_a-")],
  bearer: [pad("Bearer", " "), fill("Bearer "), fill("bearer%20"), pad("Bearer ", "%20"), fill("Bearer \n")],
  urlUserinfo: [pad("https://a@", "a"), fill("a://a@"), pad("https://a:b@", "@"), fill("https://a@["), fill("a+"), fill("https://a:@"), fill("://"), pad("https://a:", "@a"), pad("https://", "a"), pad("x", "a+b"), fill("https://:@"),
    pad("https://u:", "@"), pad("x://:", "@" + "b".repeat(20)), fill("a://:"), fill("https://a:p@"), pad("https://", "a@"), pad("https://u:p", "@a.a:1")],
  textbox: [fill("- textbox [ref=e1] "), pad('- textbox "', "a:"), fill("textbox "), fill('- textbox "pass" '), pad('- textbox "', '\\"'), pad(" ".repeat(300) + "- textbox", " "),
    fill('- textbox "a" '), fill("\n  - textbox:")],
  textboxLabel: [fill('textbox "pass'), pad('textbox "pass"', " "), fill('textbox "key" :'), pad("textbox", " ")],
  flag: [fill("--auth"), pad("--password", " "), fill("-token-"), pad("--token", "-"), fill(" --secret "), pad("--token ", '"'), fill("--token '")],
  sig: [fill("?sig=&"), pad("&sig=", "a")],
  oauthCode: [fill("?code="), pad("&code=", "a"), fill("&code=#")],
  slackHook: [fill("hooks.slack.com/services/"), pad("hooks.slack.com/services/", "a")],
  curl: [fill("curl "), fill("curl -u "), pad("curl ", "\\\n"), fill("curl\\\n"), pad("curl", " -b '")],
  mysql: [fill("mysql -p"), fill("mariadb "), pad("mysql", " -p'"), fill("mysqldump\\\n")],
  sshpass: [fill("sshpass -p "), pad("sshpass", " -p"), pad("sshpass -p ", '"')],
  dockerLogin: [fill("docker login "), pad("docker", " "), fill("docker login -p "), pad("docker login", " --password=")],
  curlFlag: [fill(" -u "), pad(" --user", " "), fill(" -b'"), pad(" -u ", '"'), fill(" --cookie=")],
  mysqlFlag: [fill(" -p"), pad(" -p'", "a"), fill(' -p"')],
  passFlag: [fill(" -p "), fill(" --password="), pad(" --password", " "), fill(" -p -")],
  namedScan: [fill("password"), fill("key."), fill("a="), fill('"token":'), pad('password: "', "a"), pad("pass='", "a b"), fill('a:"'), pad("token", " "), pad("token=", " "), ...NAMED_MORE],
  named: [fill("password"), fill("key."), fill("a="), fill('"token":'), fill("pass "), fill("token-"), pad("secret", "_"), fill("key:"), pad("api_key", " "), fill("$pw "),
    fill('\\"password\\":\\"'), pad('password: "', "a"), pad("pass='", "a b"), fill('a:"'), fill("pw = "), pad("token", " "), pad("token=", " "), pad("token:", "\n"), fill("dbPw:"), ...NAMED_MORE],
  secretName: [fill("pass"), pad("a", "Pw"), fill("_pw"), fill("service_rol")],
  valueRest: [fill("[hidden]"), fill("[hidden"), fill("a[hidden]"), fill("[")],
  urlValue: [fill("%2"), fill("%26a"), pad("a", "%"), fill("%22")],
  envLine: ["A".repeat(N), fill("A_"), fill("AB="), pad("A", "B"), fill(" A="), pad("A=", '"'), pad("A='", "a"), fill('A="')],
  awsSecret: [fill("aB1/"), pad("/", "aB1+"), fill("A".repeat(40) + "="), fill("aB1/".repeat(10) + " ")],
  keyLine: [fill("aB1+"), pad("    1\t", "aB1/"), fill("\n" + " ".repeat(64)), pad(" ".repeat(64) + "1\t", "a"), fill("1" + String.fromCharCode(0x2192)), fill("aB1+".repeat(16) + " \n")],
  keylike: [fill("aB1"), fill("a".repeat(31) + "."), fill("aB1-")],
  ansi: [pad(ESC + "[", "1;"), fill(ESC + "["), pad(ESC + "[", " "), pad(ESC + "[1", ";")],
  hidden: [fill(ZW), fill(ZW + "a")],
  hiddenSoft: [fill(ZW), fill(ZW + "a"), fill(ESC + "\t"), fill(SHY), fill(SHY + ESC)],
  secretBase: [fill("secret"), pad("a", ".pem"), fill("id_rsa"), fill(".env"), fill("a."), pad("credentials", "a")],
  secretDir: [fill("/.ssh"), fill("/.config/"), pad("/", ".aws")],
  secretFile: [fill("secret/"), pad("C:/", ".env"), fill(".ssh/"), fill("/credentials"), fill("secretsecret/x"), pad("/", "a.pem"), fill("id_rsa/")],
  playwright: [pad("mcp__", "playwright_"), pad("mcp__playwright", "_"), pad("mcp__", "a"), pad("mcp__", "playwright__browser_")],
  pageUrl: [fill("- Page URL: "), pad("- Page URL: ", "x")],
  pageTitle: [fill("- Page Title: \n"), pad("- Page Title: ", "x")],
  snapshot: [fill("### Snapshot\n```yaml\n"), pad("### Snapshot\n```yaml\n", "a\n"), fill("### Snapshot\n"), pad("### Snapshot\n```yaml\n", "``\n")],
  error: [fill("### Error\n"), pad("### Error\n", "a"), fill("\n### "), pad("### Error\n", "\n##")],
  errorHead: [fill("### Error\n"), fill("### Error"), pad("### ", "Error")],
  shotLink: [pad("- [Screenshot of x](", "a"), fill("- [Screenshot of x]("), pad("- [Screenshot of ", "]")],
  links: [pad("Links: [", "["), fill("Links: [\n"), pad("Links: [", '{"title":"a"},')],
  shotId: [fill("0"), fill("0123456789abcdef ")],
  space: [fill(" \t")],
  match: [fill("a:1"), pad("a", "1:"), fill("a")],
  numbered: [pad(" ", "1"), fill("1 "), pad("1", " ")],
  snapLine: [pad('- textbox "', '\\"'), pad("- link", " [a]") + "x", fill('- button "x" '), pad('- a "x"', " [ref=e1]") + "x", pad("- a ", ":")],
  heading: [pad("#", " "), fill("# ")],
  listItem: [pad("-", " "), fill("- ")],
  quote: [fill('\\"')],
  level: [fill("level=")],
  ref: [fill("[ref="), pad("[ref=", "a")],
  // The names the value cuts changed, the line rule's parts, the lines that belong to a secret line, the bar
  escs: [fill(ESC), fill(ESC + "a")],
  secretWords: [fill("passwor"), fill("identified "), pad("identified", " "), pad("identified", " \t"), fill("tokeni"), fill("connection_strin"), fill("auth_"), fill("api-ke"), fill("private ke"), fill("access_ke")],
  dsnName: [fill("dsn"), pad("dsn", " "), fill(' dsn"'), pad(" dsn'", " \t")],
  upperKey: [fill("A_"), fill("A_KEYA"), pad("A", "_"), fill("A_KEY_"), fill(" A_KE"), pad(" A", "B_KE")],
  pwField: [fill("pass "), pad("pass", " "), pad("pwd'", " "), fill(" pw="), fill(" pw'")],
  pwCamel: [fill("aPass "), pad("dbPw", " "), fill("aPw"), fill("aPW'"), pad("aPwd", "\t")],
  pwFlag: [fill("--pass"), fill("-pw-"), fill(" -pwd"), fill("--pwd_"), fill(" -")],
  userFlag: [fill("-u."), fill(" -u "), pad("--user=", "a"), pad(" --proxy-user ", "a"), fill(" -u a"), pad(" -u '", "a"), pad(" -u", " "), fill(" --user ")],
  login: [pad("a", " "), fill("a login"), fill("a" + " ".repeat(63)), fill(" login"), fill("a\tlogin-")],
  pFlag: [fill(" -"), fill("-p")],
  pGlued: [fill(" -p-"), fill(" -p "), fill(" -")],
  mysqlWord: [fill("mysql"), fill("_mariadb"), fill("mysq")],
  sshpassWord: [fill("sshpass"), fill("sshpas")],
  opensslWord: [fill("openssl"), fill("openss")],
  opensslFlag: [fill(" -k"), fill(" -pas"), fill(" -k-")],
  urlUser: [fill("a://"), pad("a://", "a"), pad("a", "a"), fill("a+"), fill("_a://a"), pad("https://", ":"), pad("https://a", "@"), fill(" a:/")],
  goDsn: [fill("@"), fill(":@tcp"), pad(":", "a"), fill("a:@unix"), fill(":a@tc"), pad(":", "@"), fill(":" + "a".repeat(255) + "@")],
  snapBox: [fill("textbox"), fill("searchbo"), fill("_textbox ")],
  snapValue: [fill("[ref=a]"), fill("[ref=a] ["), pad("[ref=a]", " [a]"), fill("[ref="), pad("[ref=a]:", " "), pad("[ref=a] [", "a"), pad("[ref=a]", " ".repeat(64) + "[]")],
  opens: [fill("a"), fill(":a"), pad("a", " "), fill("|+a"), fill("\\ ")],
  pemBegin: [fill("-----BEGIN "), pad("-----BEGIN ", "A"), fill("-----BEGIN A----"), pad("-----BEGIN", " ")],
  pemEnd: [fill("-----END "), pad("-----END ", "A"), fill("-----END A----"), pad("-----END", " ")],
  readGutter: [pad(" ".repeat(16), "1"), fill("1"), fill(" 1"), pad("\t", "1")],
  grepGutter: [pad("a", ":"), fill("a-1"), pad("C:", "a"), fill("a:1"), pad("a", "-1"), pad("a", "1-")],
  shape: [fill(" "), fill("\t"), pad("a.js:1:", " "), pad("     1\t", " \t"), pad("a", "1:")],
  quoteAfter: [fill('"'), fill("\\"), fill("'a"), fill("a'"), fill("`"), fill('\\"'), pad('"', "a"), fill("` ")],
  barLine: [fill(" "), pad(" ".repeat(80), "1"), fill(NUL), pad(" ".repeat(80) + NUL, "1")],
};
// a text of many lines, each shape the lines that belong to a secret line take: a run of short lines, of secret lines,
// of names that open the next line, continuations, key blocks with no end or no start, quotes left open, deeper indents
const deep = (head) => (head + Array.from({ length: 400 }, (_, i) => " ".repeat((i % 79) + 1) + "a").join("\n")).slice(0, N);
const LINES = [fill("\n"), fill("a\n"), fill("password\n"), fill("password:\n"), fill("token=\n"), fill("password \\\n"), fill("password `\n"), fill("-----END X-----\n"),
  fill("-----BEGIN X-----\n"), fill('password="\n'), fill("'\n"), fill('"\n'), fill("`\n"), fill("a `\n"), fill("password{\n"), fill("password: |-\n"), deep("password:\n"),
  deep(""), fill("password\n a\n  a\n   a\n"), fill("\r\n"), fill("password\r"), fill("\t"), fill("password\n "), fill(" password\n"), fill("     1\tpassword:\n"),
  fill("a.js:1:password\n"), pad("password:\n", " a\n"), fill("password \"a\n")];
OWN.screenRows = LINES;
// config files' ancestry, a Grep's windows, a command that prints secrets
const windows = (gutter) => Array.from({ length: 2000 }, (_, i) => gutter(i + 1) + " ".repeat((i * 7) % 41) + "x").join("\n").slice(0, N);
const CONFIG_LINES = [fill("  a\n"), fill("a\n  b\n    c\n"), deep(""), fill("\n"), fill("     5\t  a\n"), windows((n) => String(n).padStart(6) + "\t"), fill(" \n"), deep("password:\n"),
  fill("{\n"), fill("a\n" + " ".repeat(80) + "b\n")];
const GREP_LINES = [fill("config.yml-1-  a\n"), fill("a.yml:1:    x\n"), fill("--\n"), windows((n) => "a.yml-" + n + "-"), windows((n) => "a.yml:" + n + ":"), fill("a.yml:  x\n"),
  fill("a.yml-1-\n"), pad("a.yml", "-1"), fill("C:/w/a.json:1:" + " ".repeat(60) + "x\n")];
const GREP_FILE_LINES = [fill("1:  a\n"), windows((n) => n + "-"), fill("  a\n"), fill("--\n"), fill("1-\n")];
Object.assign(OWN, {
  configBase: [fill("a."), pad("a", ".yml"), fill(".yaml."), pad("docker-compose", "a"), fill("dockerfile."), pad("a".repeat(300), ".json"), fill(".")],
  readNum: [fill(" "), pad(" ".repeat(16), "1"), fill("1"), pad("1", "\t")],
  grepLine: [pad("a", ":"), fill("a-1"), pad("C:", "a"), fill("a:1:"), pad("a", "-1"), fill("a-1-1"), pad("a:", "1")],
  grepNoNum: [pad("a", "b"), fill("C:a"), fill("a-")],
  numGutter: [fill("1"), fill("1:"), pad("1", "-")],
  configRows: CONFIG_LINES, grepRows: GREP_LINES, grepFileRows: GREP_FILE_LINES,
  commandWords: [fill(" "), fill(";|"), fill("a=")],
  quoted: [fill('"'), pad('"', "a"), fill("'`"), pad("a", '"')],
  secretCommand: [fill("cat .env "), fill("a "), fill("password "), fill(".env"), fill("a=b "), fill('"'), fill("a/.ssh/")],
});
// Token and auth, PASS in capitals, the owner words, a key line, the sibling value rule, the two-way cut
Object.assign(OWN, {
  tokenWord: [fill("token"), fill("tokens"), fill("token_"), fill("tokenCoun"), fill("TOKEN-LIMI"), fill("tokeni"), fill("tokenS")],
  authWord: [fill("auth"), fill("_auth "), fill("oauth"), fill("authauth")],
  passCaps: [fill("A_PASS"), fill("PASS "), pad("A_PASS", " "), fill(" PASS="), pad("PASS", " \t"), fill("-PASS'"), pad("A-PASS'", " ")],
  keyStart: [fill("a"), pad("- ", " "), pad("-", "\t"), fill('"a'), pad("a", " "), pad('- "', "a"), fill("a."), pad("a", "'")],
  nameField: [fill("name"), pad("- name", " "), pad("name: ", '"'), pad("name:", "a"), fill("ParameterKey"), pad("- ", " \t")],
  valueField: [fill("value"), pad("value", " "), fill('"val'), pad('"Value"', " ")],
  pwEnd: [fill("pass"), fill("_pw"), fill("a-pwd"), fill("passpass ")],
  pwOwnedEnd: [fill("dbPass"), fill("DbPw"), fill("userPwd "), pad("db", "Pass"), fill("aDbPass_"), fill("keystoreP"), fill("aDB")],
  namesSecret: [fill("password"), fill("dbPass"), fill("_pw"), fill("token"), fill("A_PASS")],
  cutBoth: [fill("password=a "), pad('password: "', "a"), fill("A=b "), fill("aB1/"), fill("curl -u a:b "), fill("token=[hidden]")],
});
// One vocabulary, the sibling rule both ways, an expression's span (a 16 KB run of unclosed brackets) and
// its continuations (a 16 KB run of ? and : lines)
Object.assign(OWN, {
  dsnEnd: [fill("dsn"), fill("adsn"), pad("a", "dsn ")],
  eqSep: [fill("%3"), fill("&#6"), fill("\\u003"), fill("=")],
  listItem: [fill("-"), pad("-", " "), fill("- \t")],
  gutterless: [fill(" "), pad("     1\t", " "), pad("a.js:1:", " "), fill("\r")],
  blockHead: [fill(")"), pad(")", " "), fill("class "), pad("class", " a"), fill("): a"), pad(")", ":"), pad("):", " a"), fill("else "), fill("=>"), pad("interface", "<a,b>"), fill(") -> a(")],
  contStart: [fill(" "), pad(" ", "+"), fill(" ?"), fill(" ++"), fill(".."), pad("\t", "&&")],
  contEnd: [fill("+"), fill("?"), fill("a+ "), fill("&&a"), fill("++")],
  brackets: [fill("("), fill('("'), fill("/*"), fill("/* */("), fill("'"), fill("a'("), fill(" #("), fill("\\"), fill(")"), pad('"', '\\"'), fill("{[(")],
});
OWN.blockBrace = OWN.blockHead;
// A 16 KB name that ends in Key, a run of _key_key_key, names whose part before key is on the deny list,
// pin code and signature fields, Go and Rust headers, and an expression span that walks outward
Object.assign(OWN, {
  keyNameRe: [pad("a", "a") + "Key", fill("aKey"), fill("_key"), fill("cache_key "), fill("aK"), fill("Ke"), pad("A", "1") + "Key", fill("a-Key."), fill("monkey ")],
  keyName: [pad("a", "a") + "Key", fill("_key"), fill("cacheKey "), fill("cache_key "), fill("sortKey,"), fill("aK"), fill("Key")],
  pinField: [fill("pin"), fill("pinCode "), fill("aPinCode"), fill("PIN_CODE "), pad("pin_code", " "), fill("Pin-")],
  pinEnd: [fill("pin"), fill("pinCode "), fill("aPin_Code"), fill("PINCODE ")],
  sigField: [fill("signature"), pad("signature", " "), fill("signature' "), fill("Signature=>")],
  sigEnd: [fill("signature"), fill("signature ")],
  goRust: [fill("pub "), pad("pub", " "), pad("pub", "\t"), fill("fn"), fill("func")],
  opensBlock: [fill("func a() b {"), pad("fn ", "a"), pad("pub ", " "), fill(")"), fill("{")],
});
OWN.screenRows.push(pad("const token = foo(", "(a, {\n"), pad("const token = foo(", "{\n},\n"), fill("func Token() string {\n"), pad("token = (", ")\n"),
  pad("const appKey = (", "(\n)\n"));
OWN.secretWords.push(fill("passcode"), fill("passke"));
OWN.pwField.push(fill("PASS "), fill("Pass:"), pad("pwd", " "));
OWN.pwCamel.push(fill("dbPass "), pad("userPw", " "), fill("aDbPw"), pad("aDB", "PASS'"), fill("forceSinglePass:"));
OWN.screenRows.push(fill("name: password\n"), fill("- name: pass\n  x: 1\n"), fill('  "Name": "token",\n  "Value": "x",\n'), pad("- name: password\n", "  value: |\n    x\n"),
  pad("password: a\n", "  b\n"), fill("token = (\n"), pad("token = ", "("), pad("token = (\n", "(\n"), pad("token = a\n", "  ? b\n  : c\n"), fill("token ?\n"), fill("const token = {\n"),
  fill("if (token) {\n"), fill('  "value": 1,\n  "name": "password",\n'), pad("token = [\n", "  ]\n  [\n"), pad("token = (\n", "  . a\n"));
OWN.secretLine = [...OWN.secretWords, ...OWN.dsnName, ...OWN.upperKey, ...OWN.pwField, ...OWN.pwCamel, ...OWN.pwFlag, ...OWN.userFlag, ...OWN.login, ...OWN.mysqlWord,
  ...OWN.sshpassWord, ...OWN.opensslFlag, ...OWN.urlUser, ...OWN.goDsn, ...OWN.snapValue, fill("a login -p"), fill("mysql -pa"), fill("textbox [ref=a] ["),
  ...OWN.tokenWord, ...OWN.authWord, ...OWN.passCaps, ...OWN.keyName, ...OWN.pinField, ...OWN.sigField];
// More names; a 16 KB heredoc with no closing tag, a 16 KB XML element with no close and 16 KB of SQL
// with no ;, a flush list, a Kubernetes Secret, blank lines and a fence after a label, comment lines before a
// continuation, regex literals that never end, a long line's fragment
Object.assign(OWN, {
  camelAuth: [fill("aAuth"), fill("aAuth "), pad("aAuth", " "), fill("aAuth'")],
  camelAuthEnd: [fill("aAuth"), fill("aAuth ")],
  argName: [fill('("a",'), fill('(["a"],'), fill('["DB_PASS"] '), pad('("', "a"), pad('["', "a"), fill("( '"), fill("[ '")],
  argField: [fill('("a",'), fill('(["a_pass"],'), fill('["DB_PASS"] '), fill('["a"]=')],
  fieldLine: [fill("pin"), fill("aAuth "), fill("pass"), fill("dsn ")],
  toolPw: [fill("zip 7z -p mongo -U a% net use /user:"), pad("smbclient -U ", "a"), pad("smbclient --user=", "a"), fill("zip -"), fill("net  ")],
  ctrlHead: [fill("if"), fill("else"), pad("if", " ")],
  commentLine: [fill("/"), fill("#")],
  fence: [fill("`"), fill("~")],
  tagEnd: [fill(";"), fill(";a")],
  heredoc: [fill("<<<'A "), fill("<<"), pad("<<A", " "), pad("<<A;", "a"), fill("<<A<<"), pad("<<-", " ")],
  xmlOpen: [pad("<a", " "), pad("<a ", "b=c "), pad("<a>", "x"), fill("<"), pad("<a", "a")],
  sqlHead: [fill("insert into "), fill("update t set "), pad("update ", " "), pad("update a", " "), fill("upsert")],
  sqlEnd: [fill(";"), fill("; "), pad(";", "-"), fill(";--")],
  k8sSecret: [pad("kind:", " "), fill("kind: Secret")],
  docSep: [fill("-"), fill("--- ")],
  tickAfter: [fill("="), fill("return"), fill(" ")],
  tickOpens: [fill(" "), fill("="), fill("a"), pad("return", " ")],
  regexEnd: [fill("["), fill("/"), fill("\\"), pad("/[", "/")],
  fragmentRows: [fill("password "), fill("a\n"), pad("x", "y")],
});
OWN.secretLine.push(...OWN.camelAuth, ...OWN.argField, ...OWN.toolPw, fill("aKeyHexKeyB64Key"), fill("appkeyappkey"), fill("mot_de_pass"));
OWN.quoteAfter.push(fill("= /["), fill("(/"), fill(": /a"), pad("x = ", "`"), fill("// \""), fill(" #\""));
OWN.brackets.push(fill("= /["), fill("(/("), fill(",/[(/"));
OWN.screenRows.push("password = <<EOS\n" + fill("x\n"), "<password>\n" + fill("y\n"), "INSERT INTO t (api_key)\n" + fill("('a'),\n"), "api_keys:\n" + fill("- a\n"),
  "kind: Secret\n" + fill("a: b\n"), fill("The token is:\n\n\n"), "The token is:\n\n" + fill("```\n"), "const token = a\n" + fill("// x\n"), fill("token = /[\n"),
  fill("password = <<EOS\n"), fill("<privateKey>\n"), fill("UPDATE t SET api_key = 1\n"));
OWN.grepFileRows.push("4:secrets:\n" + fill("5-- a\n"), fill("1:password:\n2-- a\n"));
OWN.bar = OWN.barLine;
const best = (f) => bestMs(f, LIMIT);
const show = (s) => JSON.stringify(s.slice(0, 40)) + "... (" + s.length + ")";
const run = (re, s) => (typeof re === "function" ? re(s) : s.replace(re, ""));
const ALL = [...LISTED, ...Object.values(OWN).flat()];

// the slowest run a test saw, printed with its result
const slowest = (t, top) => t.diagnostic(`slowest: ${top.name} ${top.ms.toFixed(1)} ms on ${show(top.s)}`);

test("the timing check itself: a pattern that backtracks without end is over the limit, however often it is run again", () => {
  const bad = /^(a+)+$/;
  // each letter more doubles it: grown until one run uses 3 times the limit on this machine, however fast it is
  let s = "a".repeat(20) + "!";
  bad.test(s); bad.test(s); // the first run is interpreted and several times slower than the compiled ones after it
  for (let used = 0; used < 3 * LIMIT && s.length < 45; ) {
    s = "a" + s;
    const c = process.cpuUsage();
    bad.test(s);
    const u = process.cpuUsage(c);
    used = (u.user + u.system) / 1e3;
  }
  assert.ok(best(() => bad.test(s)) >= LIMIT);
});

test("every regex the screens use finishes each crafted 16 KB input in under 100 ms (best of 3)", (tc) => {
  const res = { ...SCREEN_RES, ...SCREEN_PARSERS, ...PAGE_RES };
  assert.ok(Object.keys(res).length >= 30, "the modules export their screen regexes: " + Object.keys(res).join(", "));
  const slow = [];
  let top = { ms: -1 };
  for (const [name, re] of Object.entries(res)) {
    assert.ok(OWN[name], `${name} has crafted inputs of its own`);
    for (const s of [...OWN[name], ...LISTED]) {
      const t = best(() => run(re, s));
      if (t > top.ms) top = { name, ms: t, s };
      if (t >= LIMIT) slow.push(`${name} ${t.toFixed(0)} ms on ${show(s)}`);
    }
  }
  slowest(tc, top);
  assert.deepEqual(slow, []);
});

test("cutSecrets and screenLines finish each crafted input in under 100 ms (best of 3)", (tc) => {
  const slow = [];
  let top = { ms: -1 };
  for (const s of ALL) {
    for (const [name, f] of [["cutSecrets", cutSecrets], ["screenLines", screenLines]]) {
      const t = best(() => f(s));
      if (t > top.ms) top = { name, ms: t, s };
      if (t >= LIMIT) slow.push(`${name} ${t.toFixed(0)} ms on ${show(s)}`);
    }
  }
  slowest(tc, top);
  assert.deepEqual(slow, []);
});

test("the page's text parser finishes each crafted input in under 100 ms (best of 3)", () => {
  const slow = [];
  for (const s of ALL) {
    for (const lines of [[s], [s, "- generic [ref=e1]"]]) {
      const t = best(() => pageItems(lines));
      if (t >= LIMIT) slow.push(`pageItems ${t.toFixed(0)} ms on ${show(s)}${lines.length > 1 ? " (a snapshot)" : ""}`);
    }
  }
  assert.deepEqual(slow, []);
});

test("a whole screen built from crafted results finishes in under 100 ms (best of 3), however its result is shaped", (tc) => {
  const result = (sec, id, content) => ({ type: "user", timestamp: at(sec), isSidechain: false, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] } });
  const slow = [];
  let top = { ms: -1 };
  for (const s of [...LISTED, ...OWN.named, ...OWN.flag, ...OWN.urlUserinfo, ...OWN.curl, ...OWN.jwt, ...OWN.textbox, ...OWN.snapshot, ...OWN.error, ...OWN.shotLink, ...OWN.links, ...LINES,
    ...CONFIG_LINES, ...GREP_LINES, ...GREP_FILE_LINES]) {
    const sh = tool("Bash", { command: s }), snap = tool("mcp__playwright__browser_snapshot", {}), ws = tool("WebSearch", { query: s });
    const shots = tool("mcp__playwright__browser_take_screenshot", {}), ed = tool("Edit", { file_path: "/w/a.js", old_string: s, new_string: s + "x" });
    // a config file's Read and edit, a Grep of a folder and of one config file, a command that prints secrets
    const rd = tool("Read", { file_path: "/w/a.yml" }), ced = tool("Edit", { file_path: "/w/a.yml", old_string: s, new_string: s + "x" });
    const gr = tool("Grep", { pattern: "x" }), grf = tool("Grep", { pattern: "x", path: "/w/a.yml" }), env = tool("Bash", { command: "cat .env" });
    const page = "### Page\n- Page URL: http://localhost/\n- Page Title: T\n### Snapshot\n```yaml\n" + s + "\n```";
    for (const [label, rows] of [
      ["shell", [asst({ sec: 0, content: [sh] }), result(1, sh.id, s)]],
      ["snapshot", [asst({ sec: 0, content: [snap] }), result(1, snap.id, page)]],
      ["raw snapshot", [asst({ sec: 0, content: [snap] }), result(1, snap.id, s)]],
      ["screenshot", [asst({ sec: 0, content: [shots] }), result(1, shots.id, s)]],
      ["web search", [asst({ sec: 0, content: [ws] }), result(1, ws.id, "Links: [" + s)]],
      ["edit", [asst({ sec: 0, content: [ed] })]],
      ["config read", [asst({ sec: 0, content: [rd] }), result(1, rd.id, s)]],
      ["config edit", [asst({ sec: 0, content: [ced] })]],
      ["grep", [asst({ sec: 0, content: [gr] }), result(1, gr.id, s)]],
      ["grep of a config file", [asst({ sec: 0, content: [grf] }), result(1, grf.id, s)]],
      ["secret command", [asst({ sec: 0, content: [env] }), result(1, env.id, s)]],
    ]) {
      const t = best(() => screenOf(rows.reduce((v, r) => foldScreen(v, r), newScreens()), [{ at: 0, tool: "Bash", label: s }]));
      if (t > top.ms) top = { name: label, ms: t, s };
      if (t >= LIMIT) slow.push(`${label} ${t.toFixed(0)} ms on ${show(s)}`);
    }
  }
  slowest(tc, top);
  assert.deepEqual(slow, []);
});
