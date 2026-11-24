// Secret lines are hidden whole. A line that names a password, a key, a token, a secret or the like, or holds a
// password in a web address, travels as a bar (its indent and length) and never as text, with the lines that belong to
// it; the value cuts stay as the inner layer. Each input below is planted as a line in every multi-line surface (a
// shell's output, an Edit's old and new text, a Read, a Grep, page text, a fetched page, a reply, web search titles, an
// error) and, when it is one line, in the heads (a command, a search's pattern and query, a URL, a page's title): none
// of its text may reach the payload.
const test = require("node:test");
const assert = require("node:assert/strict");
const { newScreens, foldScreen, screenOf, SCREEN } = require("../lib/session");
const describe = require("../lib/describe");
const { at, asst, tool, text } = require("./helpers");

const { cutSecrets, screenLines } = describe;
const barOf = (l) => (typeof describe.barOf === "function" ? describe.barOf(String(l)) : null);
const ch = String.fromCharCode, BS = ch(92), ARROW = ch(0x2192), ZW = ch(0x200b), ESC = ch(27), sp = (n) => " ".repeat(n);
const result = (sec, id, content, extra = {}) => ({ type: "user", timestamp: at(sec), isSidechain: false, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, ...extra }] } });
const fold = (rows) => rows.reduce((v, r) => foldScreen(v, r), newScreens());
const screen = (rows) => screenOf(fold(rows));
const call = (sec, name, input) => { const b = tool(name, input); return { b, row: asst({ sec, content: [b] }) }; };
const ran = (name, input, out) => { const c = call(0, name, input); return screen([c.row, result(1, c.b.id, out)]); };
const PW = (verb) => "mcp__playwright__browser_" + verb;
const numbered = (s) => s.split("\n").map((l, i) => String(i + 1).padStart(6) + "\t" + l).join("\n");

// every multi-line surface, each given the planted text as one or more of its lines
const SURFACES = {
  bash: (s) => ran("Bash", { command: "run" }, "before\n" + s + "\nafter"),
  edit: (s) => screen([call(0, "Edit", { file_path: "/w/config.js", old_string: "a", new_string: s }).row]),
  old: (s) => screen([call(0, "Edit", { file_path: "/w/config.js", old_string: s, new_string: "a" }).row]),
  write: (s) => screen([call(0, "Write", { file_path: "/w/notes.md", content: "# Notes\n" + s }).row]),
  read: (s) => ran("Read", { file_path: "/w/notes.txt" }, numbered(s)),
  grep: (s) => ran("Grep", { pattern: "x" }, s.split("\n").map((l, i) => "src/a.ts:" + (i + 1) + ":" + l).join("\n")),
  page: (s) => ran(PW("snapshot"), {}, '### Page\n- Page URL: http://localhost:5173/settings\n- Page Title: Settings\n### Snapshot\n```yaml\n- heading "Settings" [level=1] [ref=e1]\n' + s + "\n```"),
  fetched: (s) => ran("WebFetch", { url: "https://docs.example.com/a" }, "# Notes\n" + s),
  reply: (s) => screen([asst({ sec: 0, content: [text("Here it is.\n" + s)] })]),
  titles: (s) => ran("WebSearch", { query: "q" }, "Links: " + JSON.stringify(s.split("\n").map((t) => ({ title: t, url: "https://a.example" })))),
  error: (s) => ran(PW("click"), { element: "Buy", ref: "e7" }, "### Error\n" + s),
};
// the one-line heads: a command, a search's pattern, a web search's query, a URL, a page's title
const HEADS = {
  command: (s) => screen([call(0, "Bash", { command: s }).row]),
  powershell: (s) => screen([call(0, "PowerShell", { command: s }).row]),
  pattern: (s) => screen([call(0, "Grep", { pattern: s }).row]),
  query: (s) => screen([call(0, "WebSearch", { query: s }).row]),
  url: (s) => screen([call(0, "WebFetch", { url: s }).row]),
  title: (s) => ran(PW("navigate"), { url: "http://localhost:5173/" }, "### Page\n- Page URL: http://localhost:5173/\n- Page Title: " + s + "\n"),
};
// every string a screen carries
const textOf = (sc) => [sc.head, sc.title, ...sc.lines, ...sc.steps.map((x) => x.label), ...sc.files.map((f) => f.name)].filter((x) => x != null).join("\n");
const bars = (sc) => [sc.head, sc.title, ...sc.lines, ...sc.lines.map((l) => l.slice(1))].filter((l) => l != null && barOf(l)).length;
// an input, and what of it must not show: by default every word holding SECRET
const parts = (e) => { const [s, ...n] = [].concat(e); return { s, needles: n.length ? n : s.match(/[A-Za-z0-9_]*SECRET[A-Za-z0-9_]*/g) || [s] }; };

// one line each
const ONE = [
  // shell, URL, JSON, YAML and code forms
  "curl -b 'sid=curlCookieSECRET5' https://x.com",
  ["http://localhost:3000/callback?code=4/0AfgeXvOauthCODEsecret&state=abc", "0AfgeXvOauthCODEsecret"],
  "redis://:redisPwSECRET9@cache.example.com:6379",
  ["https://ghtokenonlysecretvalue9f8e7d@github.com/o/r.git", "ghtokenonlysecretvalue9f8e7d"],
  ["https://admin:pa/ssSECRET@host.example.com/x", "ssSECRET"],
  ["https://admin:p@ssSECRET@host.example.com/x", "ssSECRET"],
  ["wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "wJalrXUtnFEMI", "EXAMPLEKEY"],
  ["MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7/plantedBODYSECRET+xyz0123456789AbCdEf", "plantedBODYSECRET", "MIIEvQIBADANBgkq"],
  "export service_role=svcRoleSECRET42",
  'SMTP_PW="quotedEnvSECRET3"',
  "export MY_CONN='singleQuotedSECRET4'",
  '$pw = "psPwVarSECRET7"',
  "curl -u admin:curlUserSECRET8 https://api.example.com",
  "curl --user admin:curlUser2SECRET9 https://api.example.com",
  "mysql -u root -pmysqlGluedSECRET10 db",
  "sshpass -p sshpassSECRET11 ssh me@host",
  "docker login -u me -p dockerSECRET12 registry.io",
  'curl -d "{' + BS + '"password' + BS + '":' + BS + '"escJsonSECRET14' + BS + '"}" https://x.com',
  ['password: "correct horse battery SECRET15"', "correct horse", "SECRET15"],
  "- textbox [ref=e12]: unlabeledFieldSECRET21",
  ['- textbox "Card number" [ref=e5]: 4242 4242 4242 4242', "4242 4242"],
  ["https://hooks.slack.com/services/T0ABCDEF1/B0ABCDEF2/slackHookSECRETabc25", "slackHookSECRETabc25", "T0ABCDEF1"],
  ["token is gh" + "p_AbCdEfGhIj" + ZW + "KlMnOpQrStUvWxYz0123456789", "KlMnOpQrStUvWxYz0123456789", "AbCdEfGhIj"],
  "curl -u admin:e2eCurlSECRET https://api.example.com",
  'const conn = "redis://:e2eRedisSECRET@cache:6379";',
  "- textbox [ref=e3]: e2eUnlabeledPwSECRET",
  // separators and name positions
  "'password' => 'phpArrowSECRET1',",
  ':api_key => "rubyArrowSECRET2"',
  "password => perlArrowSECRET3,",
  "app.config['SECRET_KEY'] = 'flaskSubscriptSECRET4'",
  'os.environ["DB_PASSWORD"] = "osEnvSubSECRET5"',
  'headers["x-api-key"] = "jsSubscriptSECRET6";',
  '{"name": "API_KEY", "value": "ecsValueSECRET8"}',
  '<add key="ClearTextPassword" value="nugetValueSECRET9" />',
  "<password>xmlElementSECRET10</password>",
  "{&quot;password&quot;:&quot;htmlQuotSECRET11&quot;}",
  '?q={"password"%3A"urlRawQuoteSECRET12"}',
  ["define( 'DB_PASSWORD', 'wpDefinePw10' );", "wpDefinePw10"],
  // bare values holding a delimiter
  ["password: Tr0ub4dor&ampSECRET13", "Tr0ub4dor", "ampSECRET13"],
  ["db_password = abc;semiSECRET14", "semiSECRET14"],
  ["password: abc,commaSECRET15", "commaSECRET15"],
  ["DB_PASSWORD=abc(parenSECRET16", "parenSECRET16"],
  ["token: abc}braceSECRET17x", "braceSECRET17x"],
  ["secret: abc<angleSECRET18", "angleSECRET18"],
  ['"password": "abc' + BS + '"escQuoteTailSECRET19"', "escQuoteTailSECRET19"],
  // flags and commands
  "gpg --batch --passphrase gpgPassphraseSECRET23 -d f.gpg",
  "plink -ssh -pw plinkPwSECRET24 me@host",
  "app --pass passFlagSECRET25",
  "app --pwd pwdFlagSECRET26",
  "curl --proxy-user me:proxyUserSECRET27 https://x.com",
  "curl -U me:proxyUSECRET28 https://x.com",
  "podman login -u me -p podmanSECRET29 quay.io",
  "az login -u me@x.com -p azLoginSECRET30",
  "openssl enc -aes-256-cbc -k opensslKSECRET31 -in a",
  '$cred = ConvertTo-SecureString "psSecureSECRET32" -AsPlainText -Force',
  "ConvertTo-SecureString -String 'psSecure2SECRET33' -AsPlainText -Force",
  // URL userinfo before a host of any shape
  "postgres://admin:tmplPortSECRET34@db:${PORT}/app",
  "mongodb://admin:ipv6HostSECRET35@[::1]:27017/db",
  "redis://:namedPortSECRET36@cache:port",
  "url: postgres://app:envHostSECRET@${DB_HOST}:5432/app",
  "url: postgres://app:mustacheSECRET@{{ db_host }}:5432/app",
  "postgres://user:cloudSqlSocketSECRET@/mydb?host=/cloudsql/proj:us-central1:inst",
  "postgres://user:pctSocketSECRET@%2Fvar%2Frun%2Fpostgresql/db",
  "postgres://user:placeholderPortSECRET@localhost:<port>/db",
  "url = postgres://admin:hostPortWordSECRET6@db:port/app",
  "jdbc:postgresql://u:jdbcSECRET7@[::1]:5432/db",
  "amqp://guest:amqpSECRET8@${RABBIT_HOST}/vhost",
  "https://user:emptyHostSECRET9@/path",
  ["http://admin:ipv6Pw17@[::1]:8080/status", "ipv6Pw17"],
  "set DB=postgres://user:winVarHostSECRET@%DB_HOST%:5432/db",
  "mongodb://admin:mongoSECRET@h1:27017,h2:27017/db?replicaSet=rs0",
  "postgresql://postgres.abcdefgh:supaPoolerSECRET@db.example.com:6543/postgres",
  // backslash values, a Go DSN, other token shapes
  ["password=pa" + BS + "ssBackslashSECRET1", "ssBackslashSECRET1"],
  ["db_pass: hunter" + BS + "BackslashTailSECRET2", "BackslashTailSECRET2"],
  ["client_secret=" + BS + "leadingBackslashSECRET3", "leadingBackslashSECRET3"],
  'go: "root:goDsnSECRET37@tcp(127.0.0.1:3306)/db"',
  "root:goDsnBareSECRET@unix(/var/run/mysqld.sock)/db",
  "foo-sk-AbCdEf0123456789xyzSECRET4",
  "build-AI" + "zaSyA1b2C3d4E5f6G7h8I9j0SECRET5",
  // invisible characters inside a name or a token
  "pass" + ch(0xfe0f) + "word=vs16NameSECRET38",
  "pass" + ch(0x3164) + "word=hangulNameSECRET39",
  "pass" + ch(0xffa0) + "word=ffa0NameSECRET40",
  "pass" + String.fromCodePoint(0xe0041) + "word=tagNameSECRET41",
  ["gh" + "p_AbCdEfGhIj" + ch(0xfe0f) + "KlMnOpQrStUvWxYzVS16TOKSECRET42", "VS16TOKSECRET42", "AbCdEfGhIj"],
  "pass" + String.fromCodePoint(0x1d173) + "word=musicNameSECRET43",
  "password=" + ch(0x2028) + "lineSepSECRET44",
  // page fields behind a Read's or a Grep's gutter
  "    12\t  - textbox [ref=e5]: readGutterBoxSECRET46",
  ["    13\t  - textbox \"Card number\" [ref=e6]: 4242 4242 4242 SECRET47", "4242 4242"],
  "page.yml:12:  - textbox [ref=e5]: grepBoxSECRET48",
  "    12" + ARROW + "  - textbox [ref=e5]: arrowGutterSECRET49",
  ["  - textbox [ref=e4]: readYmlUnlabeledPw1", "readYmlUnlabeledPw1"],
  ['  - textbox "Card number" [ref=e5]: 4242424242424242', "4242424242424242"],
  ['  - textbox "Email" [ref=e3]: me@example.com', "me@example.com"],
  [".playwright-mcp/page-1.yml:4:  - textbox [ref=e4]: grepYmlPw2", "grepYmlPw2"],
  ['- searchbox "Search" [ref=e9]: searchboxQuerySECRET'],
  // a value written after a [hidden] the text already held, carriage returns
  "password=[hidden][hidden]tailSECRET50",
  'password="[hidden]"quotedTailSECRET51',
  "API_TOKEN='[hidden]'envTailSECRET52",
  ["Bearer [hidden]S5ECR", "S5ECR"],
  "pass\rword=crSplitSECRET53",
  "- textbox [ref=e1]: \rcrBoxSECRET55",
  // SQL
  "ALTER ROLE app WITH LOGIN PASSWORD 'sqlRoleSECRET';",
  "CREATE USER 'u'@'%' IDENTIFIED BY 'mysqlIdSECRET';",
  // headers, flags and edge shapes
  "curl -H 'Authorization: Bearer AbCdSECRET123xyz' https://api.x.com",
  '{"authorization":"token zzSECRETzz999"}',
  "Cookie: sid=cookieSECRET777; theme=dark",
  "Set-Cookie: sid=setcookieSECRET88; Path=/",
  "https://api.x.com/cb?token=tokSECRETvalue1",
  "https://api.x.com/v1?api_key=apikeySECRET22&x=1",
  "git clone https://admin:hunter2SECRET@git.example.com/r.git",
  "sent Bearer bearerSECRETabc123",
  ["AK" + "IAIOSFODNN7EXAMPLE", "AK" + "IAIOSFODNN7EXAMPLE"],
  ["aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "wJalrXUtnFEMI"],
  ["ey" + "JhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.ey" + "JzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c", "ey" + "JzdWIiOiIxMjM0NTY3ODkwIn0", "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV"],
  "export db_password=lowerPwSECRET1",
  "MY_CONN=plainEnvSECRET5",
  '$env:API_KEY = "psEnvSECRET6"',
  "app --password=flagEqSECRET13",
  '{"client_secret": "clientSecretSECRET16"}',
  "X-API-Key: xapikeySECRET17",
  'const client = new X({ apiKey: "editApiKeySECRET18" });',
  '- textbox "Password" [ref=e12]: pageFieldSECRET20',
  '- code: "sk-proj-pageTextOpenAIkeySECRET22abc"',
  "is sk-" + "ant-api03-searchQuerySECRET23xyz leaked",
  "gh" + "p_searchQueryGhTokenSECRET24abcdEF",
  ["GOCSPX-gOcSpXplanted0123456789abcd", "gOcSpXplanted0123456789abcd"],
  "//registry.npmjs.org/:_authToken=npmrcTokSECRET26",
  "Server=db;User Id=sa;Password=connStrSECRET27;",
  "...?X-Amz-Signature=amzSigSECRET28&X-Amz-Credential=AK" + "IAxx",
  "sk_" + "live_51HstripeSECRET29abcdef",
  "sb_secret_supabaseSECRET30abcdef",
  "password:" + sp(12) + "alignedYamlSECRET31",
  "api_key =" + sp(10) + "alignedIniSECRET32",
  "token" + sp(6) + "=" + sp(2) + "spacedSECRET33",
  "Bearer" + sp(10) + "manySpacesSECRET34abc",
  "Authorization:" + sp(10) + "Basic YWxhZGRpbjpvcGVuSECRET35",
  "x-sk-proj-dashPrefixedOpenAIkeySECRET36abc",
  "key-sk-" + "ant-api03-afterDashSECRET37xyz",
  "--token-ey" + "JhbGciOiJIUzI1NiJ9.ey" + "JzdWIiOiIxMjM0In0.dashJwtSECRET38",
  "foo-gh" + "p_afterDashGhTokenSECRET39abcdEFgh",
  "x-xo" + "xb-1234567890-afterDashSlackSECRET40",
  "my.config.password=dottedNameSECRET41",
  "a.b-c_d.client-secret: mixedNameSECRET42",
  "DATABASE_URL=postgres://u:pgSECRET43@db:5432/x",
  "git+ssh://git:sshUrlSECRET44@host/r",
  "--api-key flagSpaceSECRET45",
  "--api-key" + sp(6) + "flagManySpacesSECRET46",
  '- textbox  "Password" [ref=e1]:  twoSpaceSECRET47',
  ESC + "[32mexport API_TOKEN=ansiColoredSECRET48" + ESC + "[0m",
  "PASSWORD=" + "a".repeat(10) + "longEnvSECRET49",
  "X".repeat(130) + "_TOKEN=longNameSECRET50",
  "a".repeat(140) + "_password: veryLongNameSECRET51",
  // values that try to pass as already hidden, and three hard separators
  "password=[hidden]realSECRET1",
  "API_TOKEN=[hidden]realSECRET2",
  "pass" + ZW + "word=zwKeywordSECRET3",
  "pass" + ch(0xad) + "word=shyKeywordSECRET4",
  "api" + ch(0xfeff) + "_key=bomKeywordSECRET5",
  "gh" + "p_AbCdEfGhIj" + ZW + "KlMnOpQrStUvWxYz0123456789zwTokSECRET6",
  "pass" + ESC + "[0mword=ansiKeywordSECRET7",
  "password=" + ESC + "[1mansiValueSECRET8",
  "https://x.com/?data=%7B%22password%22%3A%22urlEncSECRET9%22%7D",
  "https://x.com/?q=api_key%3DurlEqSECRET10",
  "password&#61;htmlEntSECRET11",
  '{"password":"' + BS + 'u0073ecretjsonEscSECRET12"}',
  '{"password"' + BS + 'u003a"jsonColonSECRET13"}',
  "password" + ch(0xff1a) + " fullwidthSECRET14",
  "password=crSECRET15\rpassword=x",
  "password=\rcrBeforeSECRET16",
  "password:" + sp(70) + "farSECRET17",
  "password\t\ttabSECRET18",
  "--password\ttabFlagSECRET19",
  'password = """tomlTripleSECRET21"""',
  "authorization:noSpaceSECRET22",
  "X-Auth-Token: xAuthHeaderSECRET23",
  "Secret Key: spacedNameSECRET25",
  "passwd: passwdSECRET26",
  "app -pwdgluedSECRET27",
  "Authorization: Basic YWRtaW46c2VjcmV0SECRET28",
  "HTTPS://user:upperSchemeSECRET29@host/x",
  "PaSsWoRd=mixedCaseSECRET30",
  // more separators, quotes and escapes
  "password=pa" + BS + "ssBackslashSECRET1b",
  "     12\t- textbox [ref=e3]: gutterUnlabeledSECRET",
  ['     13\t- textbox "Card number" [ref=e5]: 4242 4242 4242 SECRET', "4242 4242"],
  'page.yml:14:- textbox "Email" [ref=e7]: grepEmailSECRET@x.com',
];
// more than one line: the lines that belong to a secret line
const MANY = [
  "- name: DB_PASSWORD\n  value: k8sValueSECRET7",
  "env:\n  - name: STRIPE_SECRET_KEY\n    valueFrom:\n      secretKeyRef: { name: s, key: k8sRefSECRET }",
  "password: |\n  yamlBlockSECRET20\n  yamlBlockMoreSECRET",
  "api_key: >-\n  yamlFoldSECRET21\n  yamlFoldMoreSECRET",
  'password: "line1\nmultiLineSECRET22"',
  "curl.exe https://api.x.com `\n  -u admin:psContSECRET",
  "curl.exe https://api.x.com ^\n  -u admin:cmdContSECRET",
  "password:\n  yamlNextLineSECRET20",
  'const apiKey =\n  "nextLineSECRET19";',
  "export PASSWORD=contFirstSECRET" + BS + "\ncontSecondSECRET" + BS + "\ncontThirdSECRET",
  "$pass = ConvertTo-SecureString `\n  -String psNextSECRET -AsPlainText",
  ["-----BEGIN PGP PRIV" + "ATE KEY BLOCK-----\n\nlQOYBGplantedPGPbodySECRET/abc+def\n=Ab1c\n-----END PGP PRIV" + "ATE KEY BLOCK-----", "lQOYBGplantedPGPbodySECRET", "abc+def"],
  "-----BEGIN RSA PRIV" + "ATE KEY-----\nMIIEpAIBAAKCAQEA7SECRETbody\n-----END RSA PRIV" + "ATE KEY-----",
  "-----BEGIN OPENSSH PRIV" + "ATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUSECRETbody\n-----END OPENSSH PRIV" + "ATE KEY-----",
  "-----BEGIN ENCRYPTED PRIV" + "ATE KEY-----\nMIIFHzBJBgkqSECRETenc\n-----END ENCRYPTED PRIV" + "ATE KEY-----",
  "-----begin private key-----\nlowerKeySECRET24\n-----end private key-----",
  ["MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7AbCdEfGhIjKlMnOpQrStUv\nT7xLastLineS5ECRb64Mq==\n-----END PRIV" + "ATE KEY-----", "T7xLastLineS5ECRb64Mq", "AbCdEfGhIjKlMnOpQrStUv"],
  ["-----BEGIN PRIV" + "ATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEF\nnoEndSECRETbody", "noEndSECRETbody", "MIIEvQIBADANBgkq"],
];
// The planted values mostly hold the word SECRET, which the word rule alone would hide. So each input is also planted
// with SECRET inside a value renamed (ZQXJVW, the same length and letters, so each shape reads the same): its own
// shape must hide it. A SECRET that starts a name (SECRET_KEY, STRIPE_SECRET_KEY, "secret:") stays, as it is the name.
const neutral = (e) => {
  const r = (x) => x.replace(/(?<=[A-Za-z0-9])SECRET/g, "ZQXJVW").replace(/(?<=[A-Z])secret/g, "zqxjvw");
  const { s, needles } = parts(e);
  return [r(s), ...needles.map(r)];
};
const BOTH = (list) => list.flatMap((e) => [e, neutral(e)]);
// planted where it can appear; each leak named by surface and input
function plant(list, where) {
  const leaks = [];
  for (const e of BOTH(list)) {
    const { s, needles } = parts(e);
    for (const [k, f] of Object.entries(where)) {
      const t = textOf(f(s));
      for (const n of needles) if (t.includes(n)) leaks.push(`${k}: ${n} in ${JSON.stringify(s).slice(0, 70)}`);
    }
  }
  return leaks;
}

test("every planted input is hidden in every multi-line surface", () => {
  const leaks = plant([...ONE, ...MANY], SURFACES);
  assert.deepEqual(leaks, [], leaks.length + " leaks");
});

test("and in every one-line head: a command, a search's pattern and query, a URL, a page's title", () => {
  const leaks = plant(ONE, HEADS);
  assert.deepEqual(leaks, [], leaks.length + " leaks");
});

// A line only a name's cut changed (an env line whose name holds no secret word, its value renamed) shows as the cut
// leaves it, its value hidden in place; the leak tests above still run on it unchanged
const NAME_CUT_ONLY = ["export MY_CONN='singleQuotedZQXJVW4'", "MY_CONN=plainEnvZQXJVW5"];
test("a secret line shows as a bar, not as a cut line: in each multi-line surface, and in a head", () => {
  const none = [];
  for (const e of BOTH([...ONE, ...MANY])) {
    const { s } = parts(e);
    if (NAME_CUT_ONLY.includes(s)) continue;
    for (const [k, f] of Object.entries(SURFACES)) if (!bars(f(s))) none.push(`${k}: ${JSON.stringify(s).slice(0, 70)}`);
  }
  assert.deepEqual(none, [], none.length + " without a bar");
  assert.deepEqual(NAME_CUT_ONLY.map((s) => screenLines(s)), [["export MY_CONN='[hidden]'"], ["MY_CONN=[hidden]"]]);
  for (const s of ["mysql -u root -pmysqlGluedSECRET10 db", "gpg --batch --passphrase x -d f.gpg", "export TOKEN=abc"]) {
    for (const k of ["command", "powershell", "pattern", "query"]) assert.ok(barOf(HEADS[k](s).head), `${k}: ${s} is a bar`);
  }
  assert.ok(barOf(HEADS.url("https://user:pw@db.example.com/x").head), "a URL holding a password is a bar");
  assert.ok(barOf(HEADS.title("Reset your password").title), "a title naming a password is a bar");
  const two = HEADS.command("export TOKEN=abc\necho done").head;
  assert.ok(barOf(two), "a command whose first line is secret: a bar alone, " + JSON.stringify(two));
});

// Lines that must stay visible: planted in every multi-line surface and the heads, each shows as written.
const VISIBLE = [
  "const key = item.id;",
  "<li key={x}>",
  "    pass",
  "pwd",
  "git push -u origin main",
  "ssh -p 2222 host",
  "author: Jane",
  "import { tokenize } from './tokenizer';",
  "session ended",
  "C:" + BS + "Users" + BS + "me" + BS + "my-app" + BS + "lib" + BS + "describe.js",
  "C:/Users/me/my-app/public/floor/screens.js",
];
const OK = ch(0x2714), INFO = ch(0x2139);
const TEST_OUTPUT = [OK + " the cart total adds tax (1.204ms)", OK + " a promo code applies once (0.351ms)", INFO + " tests 12", INFO + " suites 0", INFO + " pass 12",
  INFO + " fail 0", INFO + " cancelled 0", INFO + " skipped 0", INFO + " todo 0", INFO + " duration_ms 1000.5", " Test Files  4 passed (4)", "      Tests  12 passed (12)"].join("\n");

test("ordinary lines stay exactly as written, in every surface and head", () => {
  const hidden = [];
  for (const s of [...VISIBLE, TEST_OUTPUT]) {
    for (const [k, f] of Object.entries(SURFACES)) {
      const sc = f(s), t = textOf(sc);
      if (bars(sc) || !s.split("\n").every((l) => t.includes(l.trim()))) hidden.push(`${k}: ${JSON.stringify(s).slice(0, 50)} -> ${JSON.stringify(sc.lines).slice(0, 160)}`);
    }
    if (s.includes("\n")) continue;
    for (const k of ["command", "pattern", "query"]) {
      const h = HEADS[k](s).head;
      if (h !== s) hidden.push(`${k}: ${JSON.stringify(s)} -> ${JSON.stringify(h)}`);
    }
  }
  assert.deepEqual(hidden, []);
  // and the value cuts leave them alone
  for (const s of VISIBLE) assert.equal(cutSecrets(s), s);
});

// the shape of each line: "#" for a bar, else its text
const shape = (lines) => lines.map((l) => (barOf(l) ? "#" : l));

test("the lines that belong to a secret line are hidden too", () => {
  const S = (s) => shape(screenLines(s));
  // the next line, after a line ending in = or :, an open quote, a YAML block indicator or a continuation
  assert.deepEqual(S("token =\nabc\nnext"), ["#", "#", "next"]);
  assert.deepEqual(S("password:\nhunter2\nnext"), ["#", "#", "next"]);
  assert.deepEqual(S('password: "line1\nline2\nline3"\nafter'), ["#", "#", "#", "after"]);
  assert.deepEqual(S("export PASSWORD=abc" + BS + "\ndef" + BS + "\nghi\nls"), ["#", "#", "#", "ls"]);
  assert.deepEqual(S("Set-Secret -Name a `\n-Value b\nnext"), ["#", "#", "next"]);
  assert.deepEqual(S("set PASSWORD=x ^\nmore\nnext"), ["#", "#", "next"]);
  for (const ind of ["|", ">", "|-", ">-", "|+", ">+"]) assert.deepEqual(S("api_key: " + ind + "\nv1\nnext: 1"), ["#", "#", "next: 1"], ind);
  // deeper-indented lines, to the first indented the same or less, at most 50; a blank line between them does not stop it
  assert.deepEqual(S("password: |\n  a\n\n  b\nc"), ["#", "#", "", "#", "c"]);
  assert.deepEqual(S("env:\n  - name: DB_PASSWORD\n    value: v\n  - name: PORT\n    value: \"80\""), ["env:", "#", "#", "  - name: PORT", '    value: "80"']);
  assert.deepEqual(S("  password: a\n    b\n  c"), ["#", "#", "  c"]);
  // (at most 200; that limit has its own test below)
  const deep = S("secret:\n" + Array.from({ length: 60 }, () => "  x").join("\n"));
  assert.deepEqual([deep.every((l) => l === "#"), deep.length], [true, 61]);
  // a Read's gutter is not indent
  const read = screenLines(numbered("password: |\n  a\n  b\nc"));
  assert.deepEqual(shape(read), ["#", "#", "#", "     4  c"]);
  // a key block, BEGIN to END; an END with no BEGIN hides from the top; a BEGIN with no END to the end
  assert.deepEqual(S("x\n-----BEGIN CERTIFICATE-----\nMIIB\nabc\n-----END CERTIFICATE-----\ny"), ["x", "#", "#", "#", "#", "y"]);
  assert.deepEqual(S("aaaa\nbbbb\n-----END PRIV" + "ATE KEY-----\nafter"), ["#", "#", "#", "after"]);
  assert.deepEqual(S("x\n-----BEGIN PRIV" + "ATE KEY-----\nabc\ndef"), ["x", "#", "#", "#"]);
  // ordinary lines around them stay
  assert.deepEqual(S("const a = 1;\nconst b = 2;"), ["const a = 1;", "const b = 2;"]);
});

test("a bar keeps the line's shape: its indent and its length, at most the screen's width", () => {
  const [a] = screenLines("    password = 'x';");
  assert.deepEqual(barOf(a), { indent: 4, len: 15 });
  const [b] = screenLines("token " + "x".repeat(300));
  assert.equal(barOf(b).indent + barOf(b).len, SCREEN.width);
  assert.deepEqual(barOf(screenLines("a\tpassword=1")[0]), { indent: 0, len: 13 }, "a tab counts as two spaces");
});

test("the payload never holds a hidden line's text: a planted value is in no surface's JSON", () => {
  const V = "gatePlantedValue77", L = `const dbPassword = "${V}";`;
  for (const [k, f] of [...Object.entries(SURFACES), ...Object.entries(HEADS)]) {
    const sc = f(L), j = JSON.stringify(sc);
    assert.ok(!j.includes(V) && !j.includes("dbPassword"), `${k}: ${j}`);
    for (const l of [sc.head, sc.title, ...sc.lines].filter((x) => x != null)) {
      if (l.includes(ch(0))) assert.ok(barOf(l) || barOf(l.slice(1)), `${k}: a NUL only in a bar: ${JSON.stringify(l)}`);
    }
  }
  // the block that belongs to it too, and the lines around it stay
  const sh = SURFACES.bash("password: |\n  blockGateValue88\n  more");
  const j = JSON.stringify(sh);
  assert.ok(!j.includes("blockGateValue88") && j.includes("before") && j.includes("after"), j);
});

test("an edit's hidden lines keep their - and + marks, and a context line hidden on either side stays hidden", () => {
  const E = (o, n) => screen([call(0, "Edit", { file_path: "/w/a.yml", old_string: o, new_string: n }).row]).lines.map((l) => l[0] + (barOf(l.slice(1)) ? "#" : l.slice(1)));
  assert.deepEqual(E("user: a\npassword: x1", "user: a\npassword: y2"), [" user: a", "-#", "+#"]);
  const sc = screen([call(0, "Edit", { file_path: "/w/a.yml", old_string: "user:\n  hunter2X", new_string: "password:\n  hunter2X" }).row]);
  assert.ok(!JSON.stringify(sc).includes("hunter2X"), JSON.stringify(sc.lines));
});

test("a hidden Read of a page snapshot file, and a Grep of one", () => {
  const r = call(0, "Read", { file_path: "C:/work/shop/.playwright-mcp/page-2025-01-06T10-00-00-000Z.yml" });
  const yml = numbered('- generic [ref=e1]:\n  - textbox [ref=e4]: readYmlUnlabeledPw1\n  - textbox "Card number" [ref=e5]: 4242424242424242\n  - textbox "Email" [ref=e3]: me@example.com\n  - button "Pay" [ref=e6]');
  const s = screen([r.row, result(1, r.b.id, yml)]);
  const t = textOf(s);
  for (const v of ["readYmlUnlabeledPw1", "4242424242424242", "me@example.com"]) assert.ok(!t.includes(v), v);
  assert.ok(t.includes('button "Pay"'), "the other lines stay");
  const g = ran("Grep", { pattern: "textbox" }, ".playwright-mcp/page-1.yml:4:  - textbox [ref=e4]: grepYmlPw2");
  assert.ok(!textOf(g).includes("grepYmlPw2"));
});

// A shell's output over 16 KB keeps its newest part; the line that part starts inside goes (its
// first 256 characters when it is over 1 KB). In both fixtures here the value lies in the part that goes; a cut that
// lands inside a name with its value after the cut is tested below.
test("the shell tail drops the start of the line it cuts into", () => {
  const M = '"db_password":"shellTailCutPw3",', RAW = 16384;
  const one = "a".repeat(100) + M + "b".repeat(RAW + 7 - M.length);
  assert.equal(one.slice(-RAW).slice(0, 8), 'sword":"', "the fixture's tail starts 6 characters into the name");
  const s1 = ran("Bash", { command: "dump" }, one);
  assert.ok(!textOf(s1).includes("shellTailCutPw3"), JSON.stringify(s1.lines).slice(0, 200));
  const head = "x\n".repeat(50), rest = "\nline\n".repeat(3000);
  const L = '"db_password":"tailLinePw4"', many = head + L + rest.slice(0, RAW - (L.length - 7));
  assert.equal(many.slice(-RAW).slice(0, 6), 'sword"');
  const s2 = ran("Bash", { command: "dump" }, many);
  assert.ok(!textOf(s2).includes("tailLinePw4") && s2.lines.includes("line"), JSON.stringify(s2.lines).slice(0, 200));
});

// the value cuts, the inner layer that alone serves file names and step labels
test("the value cuts take a URL's password before any host and a backslash inside a bare value", () => {
  for (const [u, v] of [["postgres://admin:tmplPortSECRET34@db:${PORT}/app", "tmplPortSECRET34"], ["mongodb://admin:ipv6HostSECRET35@[::1]:27017/db", "ipv6HostSECRET35"],
    ["postgres://app:mustacheSECRET@{{ db_host }}:5432/app", "mustacheSECRET"], ["postgres://user:cloudSqlSocketSECRET@/mydb?host=/cloudsql/p", "cloudSqlSocketSECRET"],
    ["postgres://user:pctSocketSECRET@%2Fvar%2Frun%2Fpostgresql/db", "pctSocketSECRET"], ["postgres://user:placeholderPortSECRET@localhost:<port>/db", "placeholderPortSECRET"],
    ["jdbc:postgresql://u:jdbcSECRET7@[::1]:5432/db", "jdbcSECRET7"], ["amqp://guest:amqpSECRET8@${RABBIT_HOST}/vhost", "amqpSECRET8"],
    ["https://user:emptyHostSECRET9@/path", "emptyHostSECRET9"], ["redis://:namedPortSECRET36@cache:port", "namedPortSECRET36"],
    ["password=pa" + BS + "ssBackslashSECRET1", "ssBackslashSECRET1"], ["db_pass: hunter" + BS + "BackslashTailSECRET2", "BackslashTailSECRET2"]]) {
    assert.ok(!cutSecrets(u).includes(v), cutSecrets(u));
  }
  for (const s of ["https://www.npmjs.com/package/@scope/name", "see https://example.com/@me for more", "git@github.com:o/r.git", "C:" + BS + "Users" + BS + "me" + BS + "a.js"]) assert.equal(cutSecrets(s), s);
  const esc = (v) => "{" + BS + '"password' + BS + '":' + BS + '"' + v + BS + '"}';
  assert.equal(cutSecrets(esc("escJson")), esc("[hidden]"), "an escaped JSON value still ends at its escaped quote");
});

test("every invisible character goes before the cuts, tab, newline and carriage return stay", () => {
  for (const c of [0xfe0f, 0xfe00, 0x3164, 0xffa0, 0xe0041, 0x1d173, 0x1d17a, 0x180b, 0x200d, 0x2066]) {
    assert.equal(cutSecrets("pass" + String.fromCodePoint(c) + "word=x1"), "password=[hidden]", "U+" + c.toString(16));
  }
  assert.equal(cutSecrets("a\tb\r\nc"), "a\tb\r\nc");
});

test("a JWT's second part is bounded, and a longer one is still cut", () => {
  const J = "ey" + "JhbGciOiJIUzI1NiJ9." + "eyJ" + "a1B".repeat(1700) + ".c2ln";
  assert.ok(!cutSecrets(J).includes("a1Ba1B"), cutSecrets(J).slice(0, 80));
});

// ---------- A secret's value whose name is outside the text the screen sees. The planted marker is QQMARK, a neutral
// word ("SECRET" is itself a secret word, so it would hide its line on its own).
const shows = (sc) => /QQMARK/.test(JSON.stringify(sc));
const asShown = (s) => s.split("\n").map((l) => l.replace("\t", "  ").trimEnd());

test("in a config file, a line with no visible ancestry is hidden: an Edit's fragment, a Read window, a Grep line", () => {
  const E = (file, o, n) => screen([call(0, "Edit", { file_path: file, old_string: o, new_string: n }).row]);
  const cases = {
    "edit, a YAML block's value line only": E("C:/w/config.yml", "    oldBlockQQMARK1", "    newBlockQQMARK2"),
    "edit, a k8s value line only": E("C:/w/deploy.yaml", "  value: oldK8sQQMARK3", "  value: newK8sQQMARK4"),
    "read, a window starting inside a block": ran("Read", { file_path: "C:/w/config.yml", offset: 5 }, "     5\t    readWindowQQMARK5\n     6\t    readWindowQQMARK6\n     7\tlogging: info"),
    "grep, a context line": ran("Grep", { pattern: "db:" }, "config.yml-13-    grepCtxQQMARK8"),
    "grep of one config file, no file name": ran("Grep", { pattern: "x", path: "C:/w/config.yml" }, "13:    grepFileQQMARK14"),
    "multiedit, each fragment": screen([call(0, "MultiEdit", { file_path: "C:/w/settings.yaml", edits: [{ old_string: "a:\n  b: 1", new_string: "a:\n  b: 2" }, { old_string: "      k: multiOldQQMARK15", new_string: "      k: multiNewQQMARK16" }] }).row]),
    "write, content starting indented": screen([call(0, "Write", { file_path: "C:/w/values.yml", content: "    orphanWriteQQMARK13" }).row]),
    "a docker-compose file": E("C:/w/docker-compose.override.yml", "      - A=composeOldQQMARK19", "      - A=composeNewQQMARK20"),
    // (JSON, TOML and a Dockerfile are outside this rule: their values sit on their keys' lines)
  };
  for (const [k, sc] of Object.entries(cases)) assert.ok(!shows(sc), k + ": " + JSON.stringify(sc.lines));
  // a line whose ancestry is in the window shows, and a line at indent 0 always has its ancestry
  const r = ran("Read", { file_path: "C:/w/config.yml", offset: 5 }, "     5\t    readWindowQQMARK5\n     6\tlogging: info\n     7\t  level: debug");
  assert.deepEqual(shape(r.lines), ["#", "     6  logging: info", "     7    level: debug"]);
  const g = ran("Grep", { pattern: "db:", "-A": 1 }, "config.yml:12:db:\nconfig.yml-13-  host: localhost\n--\nconfig.yml-40-    port: 5432");
  assert.deepEqual(shape(g.lines), ["config.yml:12:db:", "config.yml-13-  host: localhost", "--", "#"]);
  // the name rule still applies on top, and a fragment at indent 0 is unchanged
  const marks = (lines) => lines.map((l) => l[0] + (barOf(l.slice(1)) ? "#" : l.slice(1)));
  assert.deepEqual(marks(E("C:/w/a.yml", "mode: a\npassword: p1", "mode: b\npassword: p2").lines), ["-mode: a", "-#", "+mode: b", "+#"]);
});

test("a command that is a secret line, or names a secret file, hides its whole output", () => {
  for (const [name, command] of [["Bash", "yq .db.password config.yml"], ["Bash", "gh auth token"], ["Bash", "aws configure get aws_secret_access_key"], ["Bash", "cat .env"],
    ["PowerShell", "Get-Content .npmrc"], ["Bash", "head -3 ~/.aws/credentials"], ["Bash", "grep -h DB \"./.env.local\""], ["Bash", "docker run --env-file=.env app"]]) {
    const sc = ran(name, { command }, "aloneValueQQMARK10\n\nsecond QQMARK line");
    assert.ok(!shows(sc), command + ": " + JSON.stringify(sc.lines));
    assert.deepEqual(shape(sc.lines), ["#", "", "#"], command);
  }
});

test("the deeper-indented lines under a secret line run to 200, so a service account's JSON past 50 is hidden", () => {
  const blob = "credentials_json: |\n" + Array.from({ length: 150 }, (_, i) => `  "line${i}": "saBlobQQMARK${i}",`).join("\n") + "\nnext: 1";
  const L = shape(screenLines(blob));
  assert.deepEqual([L.slice(0, 151).every((l) => l === "#"), L.slice(151)], [true, ["next: 1"]]);
  const deep = shape(screenLines("secret:\n" + Array.from({ length: 250 }, () => "  x").join("\n")));
  assert.deepEqual([deep.slice(0, 201).every((l) => l === "#"), deep.slice(201).every((l) => l === "  x"), deep.length], [true, true, 251]);
});

test("a config read from line 1, a code file read from line 40 and git log output stay as written", () => {
  const cfg = numbered("server:\n  port: 8080\n  host: localhost\nlogging:\n  level: info\n  format: json");
  assert.deepEqual(ran("Read", { file_path: "C:/w/config.yml" }, cfg).lines, asShown(cfg));
  const json = numbered("{\n  \"name\": \"shop\",\n  \"scripts\": {\n    \"test\": \"vitest\"\n  }\n}");
  assert.deepEqual(ran("Read", { file_path: "C:/w/package.json" }, json).lines, asShown(json));
  const code = "    40\t    return total;\n    41\t  }\n    42\t}\n    43\t\n    44\texport const TAX = 0.08;";
  assert.deepEqual(ran("Read", { file_path: "C:/w/src/cart.ts", offset: 40 }, code).lines, asShown(code));
  const log = ["commit a1b2c3d4e5f60718293a4b5c6d7e8f9012345678", "Author: Jane Doe <jane@example.com>", "Date:   Mon Jan 6 12:00:00 2025 +0000", "",
    "    Add the promo row to the cart summary", "", "commit b1c2d3e4f5061728394a5b6c7d8e9f0123456789", "Author: Jane Doe <jane@example.com>", "Date:   Mon Jan 6 10:00:00 2025 +0000", "",
    "    Show shipping after the discount"];
  assert.deepEqual(ran("Bash", { command: "git log -2" }, log.join("\n")).lines, log);
});

test("known limit: a value printed alone by a command that names no secret, in a non-config file, shows", () => {
  assert.ok(shows(ran("Bash", { command: "node scripts/print-mode.js" }, "aloneLimitQQMARK12")), "pinned as left unmasked");
});

// ---------- Keep the screens real. Each narrowing has its must-stay-visible controls (a planted QQMARK that must show is
// the positive control) and must-hide tests proving it leaks nothing; the sets above run unchanged.
const isBar = (l) => !!(barOf(l) || (l && barOf(l.slice(1))));
const whole = (l) => [screenLines(l), cutSecrets(l)];

test("the ancestry rule is YAML's only; a JSON or TOML window and a Dockerfile edit stay as written", () => {
  const json = "    40\t      \"region\": \"us-east-1\",\n    41\t      \"replicas\": 3,\n    42\t      \"image\": \"shop:jsonWindowQQMARK1\"\n    43\t    },\n    44\t    \"logging\": true";
  const j = ran("Read", { file_path: "C:/w/deploy.json", offset: 40 }, json);
  assert.deepEqual(j.lines, asShown(json));
  assert.ok(shows(j), "the positive control shows");
  const toml = "    10\t  port = 8080\n    11\t  host = \"tomlWindowQQMARK2\"\n    12\t\n    13\t[logging]\n    14\tlevel = \"info\"";
  assert.deepEqual(ran("Read", { file_path: "C:/w/app.toml", offset: 10 }, toml).lines, asShown(toml));
  const E = (file, o, n) => screen([call(0, "Edit", { file_path: file, old_string: o, new_string: n }).row]);
  for (const sc of [E("C:/w/settings.json", "      \"k\": \"jsonOldQQMARK3\"", "      \"k\": \"jsonNewQQMARK4\""), E("C:/w/Dockerfile", "    --build-arg A=dockerQQMARK5", "    --build-arg A=dockerQQMARK6"),
    screen([call(0, "Write", { file_path: "C:/w/values.toml", content: "    tomlWriteQQMARK7" }).row]), ran("Grep", { pattern: "x" }, "deploy.json-41-      \"replicas\": \"grepJsonQQMARK8\"")]) {
    assert.ok(shows(sc) && !sc.lines.some(isBar), JSON.stringify(sc.lines));
  }
  // YAML keeps it: a window and fragments
  assert.ok(!shows(E("C:/w/config.yml", "    oldBlockQQMARK9", "    newBlockQQMARK10")));
  assert.ok(!shows(ran("Read", { file_path: "C:/w/config.yaml", offset: 5 }, "     5\t    readWindowQQMARK11\n     6\tlogging: info")));
});

test("a value whose sibling name field names a secret is hidden, in JSON and YAML, its other siblings stay", () => {
  const ecs = numbered('{\n  "environment": [\n    {\n      "name": "DB_PASSWORD",\n      "value": "ecsValueQQMARK1"\n    },\n    {\n      "name": "PORT",\n      "value": "8080"\n    }\n  ]\n}');
  const e = ran("Read", { file_path: "C:/w/task-def.json" }, ecs);
  assert.ok(!shows(e), JSON.stringify(e.lines));
  assert.deepEqual(shape(e.lines).slice(3, 9), ["#", "#", "     6      },", "     7      {", '     8        "name": "PORT",', '     9        "value": "8080"']);
  const k8s = "env:\n  - name: DB_PASSWORD\n    value: k8sValueQQMARK2\n  - name: PORT\n    value: \"80\"";
  assert.deepEqual(shape(screenLines(k8s)), ["env:", "#", "#", "  - name: PORT", '    value: "80"']);
  const cfn = '[\n  {\n    "ParameterKey": "DbPassword",\n    "ParameterValue": "cfnValueQQMARK3"\n  },\n  {\n    "ParameterKey": "Stage",\n    "ParameterValue": "prod"\n  }\n]';
  // (the value cut by its name still takes Stage in place, as before: ParameterKey holds key)
  assert.deepEqual(shape(screenLines(cfn)), ["[", "  {", "#", "#", "  },", "  {", cutSecrets('    "ParameterKey": "Stage",'), '    "ParameterValue": "prod"', "  }", "]"]);
  const ssm = '{\n  "Name": "/prod/db/password",\n  "Type": "SecureString",\n  "Value": "ssmValueQQMARK4"\n}';
  assert.deepEqual(shape(screenLines(ssm)), ["{", "#", '  "Type": "SecureString",', "#", "}"]);
  const yamlKey = "- key: API_KEY\n  val: yamlValQQMARK5\n- key: REGION\n  val: us-east-1";
  assert.deepEqual(shape(screenLines(yamlKey)), ["#", "#", "- key: REGION", "  val: us-east-1"]);
});

test("deeper lines belong only to a key line that opens a block; a code line hides itself (not its block's first line)", () => {
  const body = ['test("a token survives a refresh", () => {', "  const a = fetchA();", "  assert.equal(a.status, 200);", "  const b = fetchB(bodyQQMARK1);", "  const t = session.token;", "  assert.equal(b.ok, true);", "});"];
  assert.deepEqual(shape(screenLines(body.join("\n"))), ["#", "  const a = fetchA();", "  assert.equal(a.status, 200);", "  const b = fetchB(bodyQQMARK1);", "#", "  assert.equal(b.ok, true);", "});"]);
  assert.deepEqual(shape(screenLines("function getToken() {\n  const x = 1;\n  return x + 1;\n}")), ["#", "  const x = 1;", "  return x + 1;", "}"]);
  assert.deepEqual(shape(screenLines("if (token) {\n  refresh();\n  log(1);\n}")), ["#", "  refresh();", "  log(1);", "}"]);
  // a key line that opens a block keeps its block (an object's closing line too, as its bracket's span)
  assert.deepEqual(shape(screenLines("password: |\n  blockQQMARK2\n  blockQQMARK3\nnext: 1")), ["#", "#", "#", "next: 1"]);
  const sa = '{\n  "credentials": {\n    "type": "service_account",\n    "project": "saQQMARK4",\n    "client_email": "x@y.iam"\n  },\n  "region": "eu"\n}';
  assert.deepEqual(shape(screenLines(sa)), ["{", "#", "#", "#", "#", "#", '  "region": "eu"', "}"]);
  for (const opener of ["secret:", "api_key: >-", "- password: |"]) {
    assert.deepEqual(shape(screenLines(opener + "\n  openedQQMARK5\n  openedQQMARK6\nafter")), ["#", "#", "#", "after"], opener);
  }
  for (const [opener, close] of [['"private_key": [', "]"], ["auth_token = {", "}"]]) {
    assert.deepEqual(shape(screenLines(opener + "\n  openedQQMARK5\n  openedQQMARK6\n" + close + "\nafter")), ["#", "#", "#", "#", "after"], opener);
  }
});

test("token in a count or a plural is not a secret word; a token's names still are", () => {
  for (const l of ["output_tokens: 1200", "max_tokens: 32000", "const tokenCount = 5;", "usage.input_tokens += n;", "TOKEN_LIMIT=8000", "const tokens = tokenize(s);", "token_budget: 5", "function tokensOf(u) {"]) {
    assert.ok(!isBar(screenLines(l)[0]), l + ": " + JSON.stringify(screenLines(l)));
    assert.equal(screenLines(l)[0], cutSecrets(l), l + ": the line shows (the value cuts as before)");
  }
  for (const l of ["token: tokValueQQMARK1", "api_token = tokValueQQMARK2", "access_token=tokValueQQMARK3", "tokenSecret: tokValueQQMARK4", "GITHUB_TOKEN=tokValueQQMARK5", "refresh_token tokValueQQMARK6"]) {
    assert.ok(isBar(screenLines(l)[0]), l);
  }
});

test("auth as a whole word is a secret word; author, authenticate, authorize and OAuth are not", () => {
  for (const l of ["app auth 9f8e7d6c5b4a39281706f5e4d3c2b1a0", "app --auth authFlagQQMARK1", "auth: authFieldQQMARK2", "AUTH=authEnvQQMARK3", "gh auth login"]) {
    assert.ok(isBar(screenLines(l)[0]), l);
  }
  for (const l of ["author: Jane", "await authenticate(user);", "authorize the app first", "Sign in with OAuth", "the authors list"]) assert.deepEqual(screenLines(l), [l], l);
});

test("PASS in capitals counts only before =, and Pass, Pwd or Pw as a suffix only after an owner word", () => {
  for (const l of ["forceSinglePass: true", "renderPass: 2", "--- PASS: TestFoo (0.00s)", "PASS", "ok  \tshop/cart\t0.012s", "const bypass = 1;"]) {
    assert.ok(!isBar(screenLines(l)[0]), l + ": " + JSON.stringify(screenLines(l)));
  }
  for (const l of ['dbPass: "passValueQQMARK1"', 'smtpPw = "passValueQQMARK2"', "DB_PASS=passValueQQMARK3", 'userPwd: "passValueQQMARK4"', "primaryDbPass=passValueQQMARK5", "db_pass: passValueQQMARK6", "pass: passValueQQMARK7"]) {
    assert.ok(isBar(screenLines(l)[0]), l);
  }
});

test("a name-only value cut no longer marks the line, its inline cut stays; a shape cut still marks it", () => {
  for (const l of ["x.key = 5", "const passes = 3;", "key: item.id", "A[p].key === B[p].key", "MY_CONN=whNameOnlyQQMARK1"]) {
    const [shown, cut] = whole(l);
    assert.deepEqual(shown, [cut], l + ": the line shows as the value cuts leave it");
    assert.ok(!isBar(shown[0]), l);
  }
  // (an env line's cut; a name the line rule does not count, webhook_key, keeps its value now)
  assert.ok(!screenLines("MY_CONN=whNameOnlyQQMARK1")[0].includes("QQMARK"), "the inline cut still takes the value");
  // a shape cut marks its line, with a name cut on it or not
  for (const l of ["stripe_key = sk_" + "live_51HxAbCdEfGhIjKlMnOpQrSt", "const t = 'gh" + "p_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';", "curl -u admin:curlQQMARK2 https://api.example.com",
    "see https://user:urlQQMARK3@host.example.com/x", "- textbox [ref=e12]: fieldQQMARK4", "Authorization: Basic YWRtaW46cXFtYXJr"]) {
    assert.ok(isBar(screenLines(l)[0]), l);
  }
});

// ---------- Code shapes. Planted marker QQMARK; each must-hide set has its must-stay-visible neighbors.
const hid = (s) => !screenLines(s).join("\n").includes("QQMARK");
const at40 = (s) => s.split("\n").map((l, i) => String(i + 40).padStart(6) + "\t" + l).join("\n");

test("a secret line that leaves an expression's bracket open hides the lines to its close; a block's { does not", () => {
  const cases = {
    "call args": 'const token = jwt.sign(\n  { sub: id },\n  "QQMARK3",\n);',
    array: 'const secrets = [\n  "QQMARK4",\n  "QQMARK5",\n];',
    "object literal": 'const credentials = {\n  user: "QQMARK8",\n  other: "QQMARK9",\n};',
    "an object in a call": 'const token = foo(a, {\n  k: "QQMARK1"\n});',
    "the closing line holds the value": 'const password = sign(payload,\n  "QQMARK2")',
  };
  for (const [k, s] of Object.entries(cases)) assert.ok(hid(s), k + ": " + JSON.stringify(screenLines(s)));
  assert.ok(!shows(ran("Read", { file_path: "C:/w/app.ts", offset: 40 }, at40(cases["call args"]))), "end to end, a Read from offset 40");
  // the span ends where its bracket closes; a bracket in a string or a comment opens nothing
  assert.deepEqual(shape(screenLines('const secrets = [\n  "a",\n];\nconst port = 8080;')), ["#", "#", "#", "const port = 8080;"]);
  assert.deepEqual(shape(screenLines('const token = read("(");\nconst port = 8080;')), ["#", "const port = 8080;"]);
  assert.deepEqual(shape(screenLines("const token = f(a); // (see\nconst port = 8080;")), ["#", "const port = 8080;"]);
  // a { after ), =>, else, try, do or finally, a class, interface, enum or namespace header, or a function's return type
  // opens a block: its body shows
  for (const head of ["class TokenStore {", "export interface TokenSet {", "enum Secret {", "namespace Auth {", "} else { // token", "try { // token",
    "async function getToken(): Promise<string> {", "fn token() -> String {"]) {
    assert.deepEqual(shape(screenLines(head + "\n  sizeQQMARK = 1;\n}")), ["#", "  sizeQQMARK = 1;", "}"], head);
  }
  // an unclosed bracket runs to the cap, 200 lines
  const open = shape(screenLines("const token = f(\n" + Array.from({ length: 250 }, () => "  x,").join("\n")));
  assert.deepEqual([open.slice(0, 201).every((l) => l === "#"), open.slice(201).every((l) => l === "  x,"), open.length], [true, true, 251]);
});

test("a line starting with ? : . + || && ?? after a hidden line, or after one ending in + || && ?? ?, is hidden too", () => {
  const cases = {
    ternary: 'const token = isProd\n  ? "QQMARK1"\n  : "QQMARK2";',
    concat: 'const password = "a" +\n  "QQMARK3";',
    "concat, + first": 'const password = "a"\n  + "QQMARK4"\n  + "QQMARK5";',
    chain: "const token = client\n  .connect()\n  .getQQMARK6();",
    or: 'const secret = env.S\n  || "QQMARK7";',
    and: "const token = ok &&\n  QQMARK8;",
    nullish: 'const password = env.P ??\n  "QQMARK9";',
    "nested ternary": 'const token = a\n  ? b\n  : c\n    ? "QQMARK10"\n    : d;',
    "after a span": "const token = sign(\n  a,\n)\n  .then(QQMARK11);",
  };
  for (const [k, s] of Object.entries(cases)) assert.ok(hid(s), k + ": " + JSON.stringify(screenLines(s)));
  // a trailing comma ends it; a spread, ++ and C++ are no operators; a git diff's + at column 0 is its mark
  assert.deepEqual(shape(screenLines('  token: getToken(),\n  other: "QQMARK",')), ["#", '  other: "QQMARK",']);
  assert.deepEqual(shape(screenLines("  token: x,\n  ...restQQMARK,")), ["#", "  ...restQQMARK,"]);
  assert.deepEqual(shape(screenLines("token count in C++\nnextQQMARK")), ["#", "nextQQMARK"]);
  assert.deepEqual(shape(screenLines('+  token: x,\n+  other: "QQMARK",\n+  more: 1,')), ["#", '+  other: "QQMARK",', "+  more: 1,"]);
});

test("a block's { no longer hides its next line, so a body under a code line naming a token shows but its own secret lines", () => {
  for (const head of ['describe("token handling", () => {', "if (token) {", "function getToken() {", 'it("refreshes the token", async () => {']) {
    assert.deepEqual(shape(screenLines(head + "\n  const a = fetchQQMARK();\n  const t = session.token;\n  expect(a).toBe(1);\n});")),
      ["#", "  const a = fetchQQMARK();", "#", "  expect(a).toBe(1);", "});"], head);
  }
  // end to end: a Read from offset 40 shows the test's body
  const t = 'describe("token handling", () => {\n  it("counts", () => {\n    expect("QQMARK14").toBe(1);\n  });\n});';
  assert.ok(shows(ran("Read", { file_path: "C:/w/a.test.js", offset: 40 }, at40(t))), "the positive control shows");
  // an expression's { still hides its next line and its span
  assert.ok(hid('const credentials = {\n  user: "QQMARK1",\n};'));
});

test("a value key is hidden when a sibling before or after it, in the same object, names a secret", () => {
  assert.deepEqual(shape(screenLines('{\n  "value": "sibBeforeQQMARK1",\n  "name": "DB_PASSWORD"\n}')), ["{", "#", "#", "}"]);
  assert.ok(!shows(ran("Read", { file_path: "C:/w/task.json", offset: 40 }, at40('    {\n      "value": "sibBeforeQQMARK2",\n      "name": "DB_PASSWORD"\n    },'))));
  assert.deepEqual(shape(screenLines('- value: sibBeforeQQMARK3\n  name: API_TOKEN\n- value: "80"\n  name: PORT')), ["#", "#", '- value: "80"', "  name: PORT"]);
  // the other objects' values stay, before and after
  assert.deepEqual(shape(screenLines('[\n  {\n    "value": "8080",\n    "name": "PORT"\n  },\n  {\n    "value": "x",\n    "name": "DB_PASSWORD"\n  }\n]')),
    ["[", "  {", '    "value": "8080",', '    "name": "PORT"', "  },", "  {", "#", "#", "  }", "]"]);
});

test("one vocabulary: the name cut takes only names the line rule counts, so the lines it shows keep their values", () => {
  for (const l of ["output_tokens: 1200", "forceSinglePass: true", "--- PASS: TestFoo (0.00s)", "x.key = 5", "ParameterKey: Stage", '"ParameterKey": "Stage",', "renderPass: 2",
    "const tokenCount = 5;", "const passes = 3;", "const bypass = 1;", "max_tokens: 32000", "Searching renderPass: 2"]) {
    assert.deepEqual([screenLines(l), cutSecrets(l)], [[l], l], l);
  }
  // the names it counts are still cut, in a label as on a screen
  for (const [l, cut] of [["db_pass: x1", "db_pass: [hidden]"], ["dbPass=x1", "dbPass=[hidden]"], ["api_token: x1", "api_token: [hidden]"], ["auth: x1", "auth: [hidden]"],
    ["DB_PASS: x1", "DB_PASS: [hidden]"], ["dsn: x1", "dsn: [hidden]"], ["password=x1", "password=[hidden]"], ["apiKey: x1", "apiKey: [hidden]"], ["pw = x1", "pw = [hidden]"]]) {
    assert.equal(cutSecrets(l), cut, l);
  }
  // env lines keep their inline cut
  assert.deepEqual(["TOKEN_LIMIT=8000", "NODE_ENV=production"].map(cutSecrets), ["TOKEN_LIMIT=[hidden]", "NODE_ENV=[hidden]"]);
  // a key's shape is cut whatever its name (webhook_key is a key name again, the line rule counts it)
  assert.equal(cutSecrets("webhook_key=sk_" + "live_51HxAbCdEfGhIjKlMnOpQrSt"), "webhook_key=[hidden]");
});

// ---------- Key names, without over-hiding. Planted marker QQMARK.
const unaltered = (l) => assert.deepEqual([screenLines(l), cutSecrets(l)], [[l], l], l);

test("an identifier ending in a separated key is a secret's name, but for the deny list's prefixes", () => {
  for (const l of ['const webhook_key = "QQMARK1";', "session_key: QQMARK2", 'appKey = "QQMARK3"', 'stripeKey: "QQMARK7"', "hmac_key=QQMARK8", 'const encKey = "QQMARK9";',
    'sessionKey: "QQMARK10"', "consumerSecretKey: QQMARK16", 'privateKeyPem: "QQMARK20"', "x-signing-key: QQMARK21", "user.apiKey = QQMARK22"]) {
    assert.ok(isBar(screenLines(l)[0]), l + ": " + JSON.stringify(screenLines(l)));
  }
  assert.deepEqual(["webhook_key=x1", "appKey: x1"].map(cutSecrets), ["webhook_key=[hidden]", "appKey: [hidden]"], "and in a label");
  for (const l of ['queryKey: ["QQMARK50"]', 'primaryKey: "QQMARK51"', "<li key={QQMARK52}>", 'cacheKey = "QQMARK54"', 'const sortKey = "QQMARK55";', 'storageKey: "QQMARK56"',
    "keyboard: QQMARK58", 'monkey = "QQMARK59"', "turkey: 1", "whiskey = 2", "x.key = 5", "key=1", 'idempotencyKey: "abc"', 'publicKey: "abc"', 'data-key="x"',
    'i18nKey: "nav.home"', 'S3Key: "a/b.png"', "sessionKeys: 3", 'const foreign_key = "x";', "hotkey: ctrl+k", 'publishableKey: "pk"']) {
    unaltered(l);
  }
});

test("passcode and passkey are secret words, and pin_code is a field", () => {
  for (const l of ["passcode: QQMARK4", "passkey=QQMARK5", "pin_code: QQMARK12", 'pinCode = "QQMARK13"', "PIN_CODE=QQMARK14", '"pinCode": "QQMARK15"']) {
    assert.ok(isBar(screenLines(l)[0]), l);
  }
  for (const l of ["const pinned = true;", "spinCode: 1", "enter the pin code on the next screen"]) unaltered(l);
});

test("signature as a field is a secret's name, prose about a signature is not, and the URL cut stays", () => {
  for (const l of ["signature: QQMARK6", '"signature": "QQMARK7"', 'webhookSignature = "QQMARK8"', "signature => QQMARK9"]) assert.ok(isBar(screenLines(l)[0]), l);
  for (const l of ["the function signature changed", "Check the signature of foo()", "signatures: 2"]) unaltered(l);
  assert.equal(cutSecrets("https://b.s3.amazonaws.com/x?X-Amz-Signature=abc1&y=1"), "https://b.s3.amazonaws.com/x?X-Amz-Signature=[hidden]&y=1");
});

test("known limit: salt, otp, license and a bare private keep their values; package.json's private shows", () => {
  for (const l of ['salt = "QQMARK13"', "license: QQMARK14", "otp: QQMARK15", '"private": true']) unaltered(l);
});

test("when a span's bracket closes, the next one its secret line left open goes on, to the first that opens a block", () => {
  assert.ok(hid('const token = foo(a, {\n  k: 1\n},\n  "QQMARK1");'));
  assert.deepEqual(shape(screenLines("if (ready) { const token = foo(\n  aQQMARK2,\n);\n  run();\n}")), ["#", "#", "#", "  run();", "}"]);
  assert.deepEqual(shape(screenLines('describe("token handling", () => {\n  const a = 1;\n  expect(a).toBe(1);\n});')), ["#", "  const a = 1;", "  expect(a).toBe(1);", "});"]);
});

test("a Go or Rust function header that ends in { opens a code block: its body shows", () => {
  for (const head of ["func Token() string {", "func (s *Store) Token() string {", "fn token() -> String {", "pub fn token_store() {"]) {
    assert.deepEqual(shape(screenLines(head + "\n  x := loadQQMARK()\n  return x\n}")), ["#", "  x := loadQQMARK()", "  return x", "}"], head);
  }
});

// ---------- More names and shapes. Planted marker QQMARK; a control must keep its marker.
const BT = ch(96), FENCE = BT.repeat(3);
const readOf = (file, s) => ran("Read", { file_path: file }, numbered(s));
const lineShows = (s, mark) => screenLines(s).join("\n").includes(mark);

test("run-together key and password names hide; _KEY names take the deny list", () => {
  const names = ["appkey", "privkey", "enckey", "hmackey", "sshkey", "webhookkey", "AESKey", "JWTKey", "HMACKey", "RSAKey", "TLSKey", "hmacKeyHex", "sessionKey2", "stripeKeyLive",
    "dbpass", "rootpass", "userpass", "mysqlpwd", "rootpwd", "smtppass", "basicAuth", "proxyAuth", "httpAuth", "serviceRole", "service-role", "passwort", "mot_de_passe",
    "DD-APP-KEY", "X-ADMIN-KEY"];
  names.forEach((n, i) => {
    for (const l of [n + ': "QQMARK' + i + '"', n + ' = "QQMARK' + i + '"']) {
      assert.ok(hid(l), l + ": " + JSON.stringify(screenLines(l)));
      assert.ok(!shows(readOf("C:/w/a.ts", l)), "a Read of " + l);
    }
  });
  for (const l of ['HMACKey: []byte("QQMARK26"),', 'public const string AESKey = "QQMARK27";', 'const JWTKey = "QQMARK28";', 'const hmacKeyHex = "QQMARK29";',
    'const webhookKeyB64 = "QQMARK30";', 'curl -H "DD-APPLICATION-KEY: QQMARK31" https://api.datadoghq.com', "SUPABASE_SERVICE_ROLE_KEY=QQMARK32", "MY_SIGNING_KEY: QQMARK33"]) {
    assert.ok(hid(l), l);
  }
  // An UPPER_CASE _KEY name whose part before _KEY is on the deny list keeps its value
  for (const l of ['const STORAGE_KEY = "QQMARK13";', 'export const QUERY_CACHE_KEY = ["QQMARK14"];', 'const STRIPE_PUBLISHABLE_KEY = "pk";']) unaltered(l);
  // the accepted limits: a plural (as tokens), and passe, too common a word
  for (const l of ["appKeys: 3", 'passe = "QQMARK15"']) unaltered(l);
});

test("pswd and the passwords of other languages are secret words, and pin is a field", () => {
  for (const l of ['{ "pin": "QQMARK1" }', "passwort: QQMARK2", 'mot_de_passe = "QQMARK3"', 'pswd = "QQMARK4"', "contrasena: QQMARK5", "senha = QQMARK6", "wachtwoord: QQMARK7",
    "haslo: QQMARK8", "salasana: QQMARK9", "PIN=QQMARK10", "user_pin: QQMARK11"]) {
    assert.ok(hid(l), l);
  }
  for (const l of ["pinned: true", 'spinner: "QQMARK5"', "pinCount: 2"]) unaltered(l);
});

test("the deny list's new prefixes keep a key name's value", () => {
  for (const l of ['e.ctrlKey && x("QQMARK1")', 'if (ev.shiftKey) go("QQMARK2");', 'altKey: "QQMARK3"', 'const metaKey = "QQMARK4";', 'const k = getKey("QQMARK5");',
    'tagKey: "QQMARK6"', 'let sumKey = "QQMARK7";', '<Select labelKey="QQMARK8" />', 'featureKey: "QQMARK9"', 'stepKey: "QQMARK10"', 'countKey = "QQMARK11"',
    'toKey("QQMARK12")', 'onKey: "QQMARK13"', 'categoryKey: "QQMARK14"']) {
    unaltered(l);
  }
});

test("a YAML list written flush with its secret key hides, in a Read, an Edit and a one-file Grep", () => {
  assert.deepEqual(shape(screenLines("api_keys:\n- QQMARK1\n- QQMARK2\nport: 1")), ["#", "#", "#", "port: 1"]);
  assert.ok(hid("passwords:\n- QQMARK3\n- QQMARK4"));
  assert.ok(!shows(readOf("C:/w/app.yml", "passwords:\n- QQMARK3\n- QQMARK4")));
  assert.ok(!shows(screen([call(0, "Edit", { file_path: "C:/w/app.yml", old_string: "x: 1", new_string: "api_token:\n- QQMARK14\n- QQMARK15" }).row])));
  assert.ok(!shows(ran("Grep", { pattern: "secrets", path: "C:/w/app.yml" }, "4:secrets:\n5-- QQMARK16\n6-- QQMARK17")));
  // an ordinary list stays, flush or not, and in a Grep of one file
  assert.ok(lineShows("colors:\n- QQMARK93\n- QQMARK94", "QQMARK94"));
  assert.ok(shows(ran("Grep", { pattern: "colors", path: "C:/w/app.yml" }, "4:colors:\n5-- QQMARK18\n6-- QQMARK19")));
});

test("a template, a raw string, a heredoc or an XML element a secret line opens hides to its close", () => {
  for (const [file, s] of [["a.js", "const secret = " + BT + "\nQQMARK7\nQQMARK8\n" + BT + ";"], ["a.ts", "const apiToken = " + BT + "\n  QQMARK9\n  QQMARK10\n" + BT + ";"],
    ["a.go", "var signingKey = " + BT + "\nQQMARK11\nQQMARK12\n" + BT], ["a.rb", "password = <<EOS\nQQMARK13\nQQMARK14\nEOS"],
    ["a.php", "$secret = <<<'EOT'\nQQMARK15\nQQMARK16\nEOT;"], ["a.sh", "cat > secrets.txt <<EOF\nQQMARK17\nQQMARK18\nEOF"],
    ["a.xml", "<privateKey>\nQQMARK19\nQQMARK20\n</privateKey>"]]) {
    assert.ok(hid(s), s);
    assert.ok(!shows(readOf("C:/w/" + file, s)), "a Read of " + s);
  }
  // the lines after the close show, and an element whose tag names no secret keeps its lines
  assert.deepEqual(shape(screenLines("password = <<EOS\nx\nEOS\nputs QQMARK1")), ["#", "#", "#", "puts QQMARK1"]);
  assert.deepEqual(shape(screenLines('<Section label="API token">\n  <p>QQMARK2</p>\n</Section>')), ["#", "  <p>QQMARK2</p>", "</Section>"]);
});

test("a label naming a secret keeps hiding through blank lines and a fenced block; the indented case too", () => {
  for (const s of ["The new admin password is:\n\n" + FENCE + "\nQQMARK1\n" + FENCE, "The demo password is:\n\nQQMARK2", "Your API key:\n\n    QQMARK3",
    "Here is the reset token:\n\n" + BT + "QQMARK4" + BT]) {
    assert.ok(!shows(screen([asst({ sec: 0, content: [text(s)] })])), s);
  }
  assert.ok(shows(screen([asst({ sec: 0, content: [text("The tests ran:\n\nQQMARK5")] })])));
  assert.ok(shows(screen([asst({ sec: 0, content: [text("The new admin password is:\n\n" + FENCE + "\nx\n" + FENCE + "\nThe build QQMARK6 passed.")] })])));
});

test("a pass, pwd, pw or signature name as a call's first argument or an assigned subscript hides its line", () => {
  for (const l of ['os.environ["DB_PASS"] = "QQMARK21"', "define('DB_PASS', 'QQMARK22');", 'os.Setenv("DB_PWD", "QQMARK23")', "ENV['SMTP_PW'] = 'QQMARK24'",
    'headers["X-Signature"] = "QQMARK25";']) {
    assert.ok(hid(l), l);
  }
  assert.ok(!shows(ran("Bash", { command: 'python -c "import os; os.environ[\'DB_PASS\']=\'QQMARK23\'"' }, "")));
  assert.ok(!shows(screen([asst({ sec: 0, content: [text("Add this:\n\n" + FENCE + "php\ndefine('DB_PASS', 'QQMARK24');\n" + FENCE)] })])));
  for (const l of ['const r = ["pass", "fail"];', 't("QQMARK", x)']) unaltered(l);
});

test("a Grep of a secrets file hides its lines, as a Read of it does", () => {
  for (const [p, out] of [["C:/Users/me/.pgpass", "1:localhost:5432:*:postgres:QQMARK4"], ["C:/w/config/secrets.txt", "3:prod QQMARK5"],
    ["C:/Users/me", "C:/Users/me/.pgpass:1:localhost:5432:*:postgres:QQMARK6"], ["C:/w/.env", "2:db_url=QQMARK7"]]) {
    assert.ok(!shows(ran("Grep", { pattern: "x", path: p }, out)), p);
  }
  assert.ok(shows(ran("Grep", { pattern: "x", path: "C:/w/a.ts" }, "1:const color = QQMARK92")));
  assert.ok(shows(ran("Grep", { pattern: "x", path: "C:/w" }, "C:/w/a.ts:1:const color = QQMARK93")));
});

test("a secret line inside a SQL statement hides the statement", () => {
  for (const s of ["INSERT INTO settings (key, value)\nVALUES ('api_key', 'QQMARK8');",
    "INSERT INTO api_keys (name, value) VALUES\n  ('first', 'QQMARK9'),\n  ('second', 'QQMARK10');", "UPDATE settings\nSET value = 'QQMARK11'\nWHERE key = 'smtp_password';"]) {
    assert.ok(hid(s), s);
  }
  assert.ok(!shows(screen([call(0, "Edit", { file_path: "C:/w/db/migrations/0001_seed.sql", old_string: "",
    new_string: "insert into public.settings (key, token)\nvalues ('mail', 'QQMARK12');" }).row])));
  assert.ok(lineShows("INSERT INTO orders (id, status)\nVALUES ('QQMARK13', 'open');", "QQMARK13"));
  assert.deepEqual(shape(screenLines("INSERT INTO api_keys (v) VALUES ('x');\nSELECT QQMARK14;")), ["#", "SELECT QQMARK14;"]);
});

test("a tool's own password flag hides its line", () => {
  for (const l of ["zip -P QQMARK32 out.zip a.txt", "7z a -pQQMARK33 out.7z dir", "unzip -P QQMARK34 in.zip", "redis-cli -h db -a QQMARK35 ping",
    'sqlcmd -S db -U sa -P QQMARK37 -Q "select 1"', "net use Z: " + BS + BS + "srv" + BS + "share /user:admin QQMARK38", "smbclient //srv/share -U admin%QQMARK39",
    "ssh-keygen -t ed25519 -N QQMARK40 -f id"]) {
    assert.ok(hid(l), l);
  }
  assert.ok(!shows(ran("Bash", { command: "mongosh mongodb://db -u admin -p QQMARK21" }, "test>")));
  for (const l of ["zip -r out.zip QQMARK1", "redis-cli -h db ping QQMARK2"]) assert.ok(lineShows(l, "QQMARK"), l);
});

test("a Kubernetes Secret hides its whole YAML document, and the next document shows", () => {
  assert.ok(hid("apiVersion: v1\nkind: Secret\nmetadata:\n  name: app\nstringData:\n  SESSION_SIGNING: QQMARK45\n  ADMIN_PIN: QQMARK46"));
  assert.ok(!shows(readOf("C:/w/s.yaml", "kind: Secret\ndata:\n  username: QQMARK47\n  api-url: QQMARK48")));
  assert.deepEqual(shape(screenLines("kind: Secret\ndata:\n  a: QQMARK1\n---\nkind: ConfigMap\ndata:\n  b: QQMARK2")),
    ["#", "#", "#", "---", "kind: ConfigMap", "data:", "  b: QQMARK2"]);
});

test("> and | open a block only as YAML's indicator; a comment and a regex literal open no quote", () => {
  assert.deepEqual(shape(screenLines('<h3 className="t">Token usage</h3>\n<div className="grid">\n  <span>QQMARK1</span>\n</div>\n<p>QQMARK2</p>')),
    ["#", '<div className="grid">', "  <span>QQMARK1</span>", "</div>", "<p>QQMARK2</p>"]);
  assert.deepEqual(shape(screenLines("<label>Auth code</label>\n<div>\n<b>QQMARK3</b>\n</div>")), ["#", "<div>", "<b>QQMARK3</b>", "</div>"]);
  assert.deepEqual(shape(screenLines('// see the "refresh_token\n// field in the docs.\nconst a = "QQMARK4";\nconst b = QQMARK5;')),
    ["#", "// field in the docs.", 'const a = "QQMARK4";', "const b = QQMARK5;"]);
  assert.deepEqual(shape(screenLines('const re = /authorization["' + BS + 's:=]+/gi;\nconst next = QQMARK15;')), ["#", "const next = QQMARK15;"]);
  // YAML's block indicators still open
  for (const s of ["password: |\n  QQMARK6", "password: >-\n  QQMARK7", "token:|\n  QQMARK8"]) assert.ok(hid(s), s);
});

test("an if, for, switch, match, while, elif or else head ending in { or : opens a code block", () => {
  for (const [s, mark] of [["for _, token := range tokens {\n\tcount(QQMARK9)\n}", "QQMARK9"], ['if token != "" {\n\tlog.Print(QQMARK10)\n}', "QQMARK10"],
    ["match token {\n    Tok::A => QQMARK11,\n}", "QQMARK11"], ["if token:\n    log.info(QQMARK12)\nrun()", "QQMARK12"], ["while token:\n    go(QQMARK13)", "QQMARK13"],
    ["elif token:\n    go(QQMARK14)", "QQMARK14"], ["switch token {\ncase 1:\n\tgo(QQMARK15)\n}", "QQMARK15"]]) {
    assert.ok(lineShows(s, mark), s);
  }
});

test("the shell tail's first kept fragment of a cut line is a bar, so a name cut at character 256 shows no value", () => {
  const RAW = 16384, kept = ("y".repeat(250) + '"db_password":"tailStraddleQQMARK27","note":"' + "w".repeat(RAW)).slice(0, RAW);
  const out = '{"a":"' + "x".repeat(4000) + '",' + "z".repeat(3000) + kept;
  assert.equal(out.slice(-RAW).slice(256, 262), "ssword", "the kept part starts inside the name");
  const s1 = ran("Bash", { command: "cat dist/build-info.json" }, out);
  assert.ok(!shows(s1), JSON.stringify(s1.lines).slice(0, 200));
  // the lines after the fragment still show
  const s2 = ran("Bash", { command: "cat dist/build-info.json" }, "q".repeat(RAW) + "\nlast line QQMARK1");
  assert.ok(isBar(s2.lines[0]) && s2.lines.includes("last line QQMARK1"), JSON.stringify(s2.lines).slice(0, 200));
});

test("a comment between a secret line and its continuation is skipped and hidden", () => {
  assert.ok(hid('const token = isProd\n  // prod value\n  ? "QQMARK25"\n  : "QQMARK26";'));
  assert.deepEqual(shape(screenLines("const token = isProd;\n// a note\nconst b = QQMARK1;")), ["#", "// a note", "const b = QQMARK1;"]);
});

test("bodyOf is gone from the screen's regexes", () => {
  assert.ok(!("body" in describe.SCREEN_RES));
});

test("a one-file Grep of any file type reads past its N- context gutter, as a YAML one does", () => {
  const out = ran("Grep", { pattern: "x", path: "C:/w/a.ts", "-A": 3 }, '4:const token = isProd\n5-  ? "QQMARK1"\n6-  : "QQMARK2";');
  assert.ok(!/QQMARK1|QQMARK2/.test(JSON.stringify(out)));
  // a plain context line stays
  assert.ok(/QQMARK9/.test(JSON.stringify(ran("Grep", { pattern: "x", path: "C:/w/a.ts", "-A": 3 }, '4:const color = "red";\n5-const size = "QQMARK9";'))));
});
