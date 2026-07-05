
const http = require("http");
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const PORT = 3000;
const root = __dirname;
const publicDir = path.join(root, "public");
const dataDir = path.join(root, "data");
const backupDir = path.join(root, "backups");
const dbPath = path.join(dataDir, "dispatch.db");

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);
if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir);

const db = new DatabaseSync(dbPath);
db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  category TEXT DEFAULT '',
  location TEXT DEFAULT '',
  aisle_slot TEXT DEFAULT '',
  haccp TEXT DEFAULT '',
  active TEXT DEFAULT 'Yes',
  notes TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  address TEXT DEFAULT '',
  active TEXT DEFAULT 'Yes',
  notes TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  active TEXT DEFAULT 'Yes',
  notes TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS outwards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  packing_slip TEXT NOT NULL,
  dispatch_date TEXT NOT NULL,
  customer_code TEXT DEFAULT '',
  customer_name TEXT DEFAULT '',
  delivery_address TEXT DEFAULT '',
  freight_detail TEXT DEFAULT '',
  comments TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS outward_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  outward_id INTEGER NOT NULL,
  product_code TEXT DEFAULT '',
  product_description TEXT DEFAULT '',
  qty_ordered REAL DEFAULT 0,
  qty_dispatched REAL DEFAULT 0,
  haccp TEXT DEFAULT '',
  batch TEXT DEFAULT '',
  FOREIGN KEY(outward_id) REFERENCES outwards(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS app_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  table_name TEXT DEFAULT '',
  record_id TEXT DEFAULT '',
  detail TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);


function ensureColumn(table, column, definition){
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c=>c.name);
  if(!cols.includes(column)){
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
ensureColumn("products", "location", "TEXT DEFAULT ''");
ensureColumn("products", "aisle_slot", "TEXT DEFAULT ''");

function send(res, code, data, type="application/json"){
  res.writeHead(code, {"Content-Type": type});
  res.end(type === "application/json" ? JSON.stringify(data) : data);
}
function readBody(req){
  return new Promise(resolve=>{
    let body="";
    req.on("data", chunk=>body+=chunk);
    req.on("end", ()=>resolve(body ? JSON.parse(body) : {}));
  });
}
function log(action, table, id, detail=""){
  db.prepare("INSERT INTO app_log (action, table_name, record_id, detail) VALUES (?,?,?,?)").run(action, table, String(id||""), detail);
}
function list(table){
  return db.prepare(`SELECT * FROM ${table} ORDER BY id DESC`).all();
}
function serveFile(req,res){
  let filePath = req.url === "/" ? "/index.html" : decodeURIComponent(req.url.split("?")[0]);
  filePath = path.join(publicDir, filePath);
  if (!filePath.startsWith(publicDir) || !fs.existsSync(filePath)) return send(res,404,"Not found","text/plain");
  const ext = path.extname(filePath).toLowerCase();
  const type = ext===".html" ? "text/html" : ext===".css" ? "text/css" : ext===".js" ? "application/javascript" : "text/plain";
  send(res,200,fs.readFileSync(filePath),type);
}
function update(table, fields, id, body){
  const set = fields.map(f=>`${f}=?`).join(",");
  db.prepare(`UPDATE ${table} SET ${set}, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(...fields.map(f=>body[f]||""), id);
}
function insert(table, fields, body){
  const qs = fields.map(()=>"?").join(",");
  const info = db.prepare(`INSERT INTO ${table} (${fields.join(",")}) VALUES (${qs})`).run(...fields.map(f=>body[f]||""));
  return info.lastInsertRowid;
}

const server = http.createServer(async (req,res)=>{
  try{
    const url = req.url.split("?")[0];

    if(req.method==="GET" && url==="/api/health") return send(res,200,{ok:true, db:dbPath});
    if(req.method==="GET" && url==="/api/log") return send(res,200,db.prepare("SELECT * FROM app_log ORDER BY id DESC LIMIT 100").all());

    for (const [table, fields, nameField] of [
      ["products", ["code","description","category","location","aisle_slot","haccp","active","notes"], "code"],
      ["customers", ["code","name","address","active","notes"], "name"],
      ["suppliers", ["name","active","notes"], "name"]
    ]){
      if(req.method==="GET" && url===`/api/${table}`) return send(res,200,list(table));
      if(req.method==="POST" && url===`/api/${table}`){
        const body = await readBody(req);
        const id = insert(table, fields, body);
        log("create", table, id, body[nameField]||"");
        return send(res,200,{id});
      }
      const m = url.match(new RegExp(`^/api/${table}/(\\d+)$`));
      if(m && req.method==="PUT"){
        const body = await readBody(req);
        update(table, fields, m[1], body);
        log("update", table, m[1], body[nameField]||"");
        return send(res,200,{ok:true});
      }
      if(m && req.method==="DELETE"){
        db.prepare(`DELETE FROM ${table} WHERE id=?`).run(m[1]);
        log("delete", table, m[1]);
        return send(res,200,{ok:true});
      }
    }

    if(req.method==="GET" && url==="/api/outwards"){
      const rows = db.prepare("SELECT * FROM outwards ORDER BY id DESC").all();
      const lineStmt = db.prepare("SELECT * FROM outward_lines WHERE outward_id=? ORDER BY id");
      rows.forEach(r=>r.lines=lineStmt.all(r.id));
      return send(res,200,rows);
    }
    if(req.method==="POST" && url==="/api/outwards"){
      const b = await readBody(req);
      const info = db.prepare("INSERT INTO outwards (packing_slip,dispatch_date,customer_code,customer_name,delivery_address,freight_detail,comments) VALUES (?,?,?,?,?,?,?)")
        .run(b.packing_slip||"", b.dispatch_date||"", b.customer_code||"", b.customer_name||"", b.delivery_address||"", b.freight_detail||"", b.comments||"");
      const line = db.prepare("INSERT INTO outward_lines (outward_id,product_code,product_description,qty_ordered,qty_dispatched,haccp,batch) VALUES (?,?,?,?,?,?,?)");
      for(const l of (b.lines||[])){
        line.run(info.lastInsertRowid,l.product_code||"",l.product_description||"",Number(l.qty_ordered||0),Number(l.qty_dispatched||0),l.haccp||"",l.batch||"");
      }
      log("create","outwards",info.lastInsertRowid,b.packing_slip||"");
      return send(res,200,{id:info.lastInsertRowid});
    }

    if(req.method==="POST" && url==="/api/backup"){
      const stamp = new Date().toISOString().replace(/[:.]/g,"-");
      const target = path.join(backupDir, `dispatch-${stamp}.db`);
      fs.copyFileSync(dbPath, target);
      log("backup","database","",target);
      return send(res,200,{ok:true,file:target});
    }


    if(req.method==="POST" && url==="/api/import-products-seed"){
      const seedPath = path.join(publicDir, "product-seed.json");
      if(!fs.existsSync(seedPath)) return send(res,404,{error:"product-seed.json not found"});
      const seed = JSON.parse(fs.readFileSync(seedPath, "utf8"));
      const existing = db.prepare("SELECT id FROM products WHERE code=?");
      const insertStmt = db.prepare("INSERT INTO products (code,description,category,location,aisle_slot,haccp,active,notes) VALUES (?,?,?,?,?,?,?,?)");
      const updateStmt = db.prepare("UPDATE products SET description=?,category=?,location=?,aisle_slot=?,updated_at=CURRENT_TIMESTAMP WHERE code=?");
      let added=0, updated=0;
      for(const p of seed){
        const found = existing.get(p.code);
        if(found){
          updateStmt.run(p.description||"", p.category||"", p.location||"", p.aisle_slot||"", p.code);
          updated++;
        }else{
          insertStmt.run(p.code||"", p.description||"", p.category||"", p.location||"", p.aisle_slot||"", p.haccp||"", p.active||"Yes", p.notes||"");
          added++;
        }
      }
      log("import","products","",`added ${added}, updated ${updated}`);
      return send(res,200,{ok:true, added, updated, total:seed.length});
    }

    serveFile(req,res);
  }catch(e){
    send(res,500,{error:e.message});
  }
});

server.listen(PORT, ()=>console.log("Dispatch running at http://localhost:3000"));
