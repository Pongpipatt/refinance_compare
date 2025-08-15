const { useMemo, useState, useEffect } = React;

// ---------- Utils ----------
const toNumber = (v) => (isFinite(+v) ? +v : 0);
const clamp2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const clamp3 = (n) => Math.round((n + Number.EPSILON) * 1000) / 1000;

function pmt(r, n, P) {
  if (r === 0) return P / n;
  const a = Math.pow(1 + r, n);
  return (P * r * a) / (a - 1);
}

// ตารางคำนวณ: ค่างวด (หรือ override) + โปะเพิ่ม (%) ของค่างวดงวดนั้น → ไปหักเงินต้นเพิ่ม
function buildSchedule({ principal, termMonths, rateSchedule, monthlyPaymentOverride = null, prepayPct = 0 }) {
  let balance = principal;
  let remaining = termMonths;
  const rows = [];
  let mIndex = 0;

  for (let seg = 0; seg < rateSchedule.length && remaining > 0; seg++) {
    const segLen = Math.min(rateSchedule[seg].months, remaining);
    const apr = rateSchedule[seg].rateYear / 100;
    const r = apr / 12;

    const basePay = monthlyPaymentOverride ? monthlyPaymentOverride : pmt(r, remaining, balance);

    for (let i = 0; i < segLen && remaining > 0; i++) {
      const interest = balance * r;
      let principalPay = basePay - interest;
      if (principalPay < 0) principalPay = 0;

      const extra = Math.max(0, basePay * (prepayPct / 100));
      let principalAll = principalPay + extra;

      if (principalAll > balance || remaining === 1) principalAll = balance;

      const endBalance = Math.max(0, balance - principalAll);

      rows.push({
        index: mIndex + 1,
        rate: rateSchedule[seg].rateYear,
        payment: basePay,
        extraPrepay: extra,
        principal: principalPay,
        principalTotal: principalAll,
        interest,
        endBalance,
      });

      balance = endBalance;
      remaining -= 1;
      mIndex += 1;
      if (balance <= 0) break;
    }
    if (balance <= 0) break;
  }

  const totalInterest = rows.reduce((s, r) => s + r.interest, 0);
  const totalPayment = rows.reduce((s, r) => s + r.payment + r.extraPrepay, 0);
  return { rows, totalInterest, totalPayment, endBalance: balance };
}

function sumOtherCosts(otherCosts) {
  return Object.values(otherCosts || {}).reduce((s, v) => s + Number(v || 0), 0);
}

const fmtMoney = (n) => Number(n || 0).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtRate  = (n) => Number(n || 0).toFixed(3);

function parseMoneyInput(str){ if(str===null||str===undefined) return 0; const v=Number(String(str).replace(/,/g,"").trim()); return isFinite(v)?v:0; }
function formatMoneyInput(v){ if(v===""||v===null||v===undefined) return ""; return fmtMoney(v); }

function MoneyInput({ value, onChange, placeholder }) {
  const [txt, setTxt] = useState(value === null ? "" : formatMoneyInput(value));
  useEffect(()=>setTxt(value === null ? "" : formatMoneyInput(value)),[value]);
  const onInput = e => setTxt(e.target.value.replace(/[^0-9.,]/g,""));
  const onBlur  = () => { const v=clamp2(parseMoneyInput(txt)); onChange(v); setTxt(txt.trim()===""? "": formatMoneyInput(v)); };
  const onFocus = e => { const v=parseMoneyInput(txt); e.target.value = v? String(v): ""; };
  return <input type="text" inputMode="decimal" className="ipt ipt-num mono" placeholder={placeholder||""} defaultValue={txt} onInput={onInput} onBlur={onBlur} onFocus={onFocus}/>;
}
function RateInput({ value, onChange }) {
  const [txt,setTxt]=useState(value===null?"":Number(value).toFixed(3));
  useEffect(()=>setTxt(value===null?"":Number(value).toFixed(3)),[value]);
  const onInput=e=>setTxt(e.target.value.replace(/[^0-9.]/g,""));
  const onBlur =()=>{ const v=clamp3(parseMoneyInput(txt)); onChange(v); setTxt(txt.trim()===""? "": Number(v).toFixed(3)); };
  const onFocus=e=>{ const v=parseMoneyInput(txt); e.target.value = v? String(v): ""; };
  return <input type="text" inputMode="decimal" className="ipt ipt-num mono" defaultValue={txt} onInput={onInput} onBlur={onBlur} onFocus={onFocus}/>;
}

// ---------- Defaults ----------
const DEFAULT_BANKS = [
  {
    name: "กรุงศรี (ปัจจุบัน)",
    principal: 2623000,
    termYears: 20,
    rate1: 5.370,
    rate2: 5.370,
    rate3: 5.370,
    rateAfter: 5.370,
    monthlyOverride: 15700,
    prepayPct: 0.000,
    otherCosts: { MRTA: 0, "ค่าประเมิน": 0, "ค่าจดจำนอง": 0, "ค่าธรรมเนียม": 0, "ค่าปรับปิดก่อน": 0 },
  },
  {
    name: "ออมสิน (โปร Q3/2568)",
    principal: 2623000,
    termYears: 20,
    rate1: 1.990,
    rate2: 3.805,
    rate3: 3.805,
    rateAfter: 6.370,
    monthlyOverride: null,
    prepayPct: 0.000,
    otherCosts: { MRTA: 0, "ค่าประเมิน": 0, "ค่าจดจำนอง": 0, "ค่าธรรมเนียม": 1000, "ค่าปรับปิดก่อน": 0 },
  },
];

function useLocalState(key, initial){
  const [state, setState] = useState(()=>{ try{ const s=localStorage.getItem(key); return s? JSON.parse(s): initial; }catch{ return initial; }});
  useEffect(()=>{ localStorage.setItem(key, JSON.stringify(state)); },[key,state]);
  return [state,setState];
}

function L({ label, children }) {
  return (<label className="block text-sm"><div className="text-gray-600 mb-1">{label}</div>{children}</label>);
}
function Th({ children, className = "" }) { return <th className={`text-left ${className}`}>{children}</th>; }
function Td({ children, className = "" }) { return <td className={`align-top ${className}`}>{children}</td>; }

// ---------- Bank editor (เพิ่มปุ่มย้ายลำดับ) ----------
function BankEditor({ bank, onChange, onRemove, onMoveUp, onMoveDown }){
  const handle=(f,v)=>onChange({ ...bank, [f]: v });
  const handleCost=(k,v)=>onChange({ ...bank, otherCosts:{ ...(bank.otherCosts||{}), [k]: v } });

  return (
    <div className="card mb-4">
      <div className="flex items-center justify-between mb-2">
        <input className="text-lg font-semibold outline-none border-b border-gray-300 px-1 bg-transparent" value={bank.name} onChange={(e)=>handle("name", e.target.value)}/>
        <div className="flex items-center gap-2">
          <button className="btn-secondary" onClick={onMoveUp}  title="ย้ายขึ้น">↑ ย้ายขึ้น</button>
          <button className="btn-secondary" onClick={onMoveDown} title="ย้ายลง">↓ ย้ายลง</button>
          <button className="btn-secondary" onClick={onRemove}  title="ลบธนาคาร">ลบธนาคาร</button>
        </div>
      </div>

      <div className="grid md:grid-cols-4 grid-cols-2 gap-3">
        <L label="ยอดกู้ (บาท)"><MoneyInput value={bank.principal} onChange={v=>handle("principal", v)} /></L>
        <L label="อายุสัญญา (ปี)"><MoneyInput value={bank.termYears} onChange={v=>handle("termYears", v)} /></L>
        <L label="ดอกเบี้ยปี 1 (%)"><RateInput value={bank.rate1} onChange={v=>handle("rate1", v)} /></L>
        <L label="ดอกเบี้ยปี 2 (%)"><RateInput value={bank.rate2} onChange={v=>handle("rate2", v)} /></L>
        <L label="ดอกเบี้ยปี 3 (%)"><RateInput value={bank.rate3} onChange={v=>handle("rate3", v)} /></L>
        <L label="หลังครบ 3 ปี (%)"><RateInput value={bank.rateAfter} onChange={v=>handle("rateAfter", v)} /></L>
        <L label="ค่างวด/เดือน (แก้ไขได้)"><MoneyInput value={bank.monthlyOverride===null? null: bank.monthlyOverride} onChange={v=>handle("monthlyOverride", v)} placeholder="คำนวณอัตโนมัติ"/></L>
        <L label="โปะเพิ่มต่องวด (%)"><RateInput value={bank.prepayPct} onChange={v=>handle("prepayPct", v)} /></L>
      </div>

      <div className="mt-4">
        <div className="text-sm font-medium mb-2 text-gray-700">ค่าใช้จ่ายอื่น ๆ (บาท) — ใส่เท่าที่มี</div>
        <div className="grid md:grid-cols-6 grid-cols-2 gap-3">
          {Object.entries(bank.otherCosts || { MRTA: 0, "ค่าประเมิน": 0, "ค่าจดจำนอง": 0, "ค่าธรรมเนียม": 0, "ค่าปรับปิดก่อน": 0 }).map(([k,v])=>(
            <L key={k} label={k}><MoneyInput value={v} onChange={(val)=>handleCost(k,val)} /></L>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------- Compare table (แสดงงวดจริงหลังโปะ) ----------
function formatTerm(termMonths){ const y=Math.floor(termMonths/12), m=termMonths%12; return `${termMonths} งวด (${y} ปี${m? " "+m+" เดือน": ""})`; }

function CompareTable({ banks, onOpenSchedule }){
  const rows = useMemo(()=>banks.map((b,idx)=>{
    const planned = Math.round(b.termYears*12);     // แผนเดิม
    const schedule = buildSchedule({
      principal: b.principal,
      termMonths: planned,
      rateSchedule: [
        { months:12, rateYear:b.rate1 },
        { months:12, rateYear:b.rate2 },
        { months:12, rateYear:b.rate3 },
        { months: Math.max(0, planned-36), rateYear:b.rateAfter },
      ],
      monthlyPaymentOverride: b.monthlyOverride,
      prepayPct: b.prepayPct || 0,
    });

    const payoffMonths = schedule.rows.length;      // ← งวดจริงหลังโปะ
    const first36 = schedule.rows.slice(0,36);
    const int3y = first36.reduce((s,r)=>s+r.interest,0);
    const other = sumOtherCosts(b.otherCosts);
    const total3y = int3y + other;
    const estMonthly = first36[0]?.payment || 0;

    return {
      index: idx,
      name: b.name,
      monthly: estMonthly,
      interest3y: int3y,
      otherCosts: other,
      total3y,
      after3yRate: b.rateAfter,
      payoffMonths,                                // ใช้อันนี้แทน planned
      totalInterestAll: schedule.totalInterest,
    };
  }), [banks]);

  const currentBase = rows[0]?.total3y ?? null;
  const best = rows.length ? Math.min(...rows.map(r=>r.total3y)) : null;

  const fmtDelta = (r)=>{
    if (r.index===0 || currentBase===null) return { text:"–", cls:"" };
    const delta = r.total3y - currentBase;
    if (Math.abs(delta) < 0.005) return { text:"0.00", cls:"" };
    if (delta > 0) return { text:`(${fmtMoney(delta)})`, cls:"text-red mono text-right" };
    return { text:`${fmtMoney(Math.abs(delta))}`, cls:"text-green mono text-right" };
  };

  return (
    <div className="table-wrap">
      <table className="min-w-full text-sm">
        <thead>
          <tr>
            <Th>ธนาคาร</Th>
            <Th className="text-right">ค่างวด/เดือน (ประมาณ)</Th>
            <Th className="text-right">ดอกเบี้ยรวม 3 ปี</Th>
            <Th className="text-right">ค่าใช้จ่ายอื่น ๆ</Th>
            <Th className="text-right">รวม 3 ปี</Th>
            <Th className="text-right">เทียบธนาคารปัจจุบัน</Th>
            <Th className="text-center">ดอกเบี้ยหลัง 3 ปี</Th>
            <Th className="text-right">จำนวนงวดที่เหลือ</Th>
            <Th className="text-right">ดอกเบี้ยรวมทั้งสัญญา</Th>
            <Th className="text-center">ตารางผ่อน</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r=>{
            const d = fmtDelta(r);
            return (
              <tr key={r.index}>
                <Td>{r.name}</Td>
                <Td className="text-right font-medium mono">{fmtMoney(r.monthly)}</Td>
                <Td className="text-right mono">{fmtMoney(r.interest3y)}</Td>
                <Td className="text-right mono">{fmtMoney(r.otherCosts)}</Td>
                <Td className="text-right font-semibold mono"><span className={r.total3y===best?"badge-best":""}>{fmtMoney(r.total3y)}</span></Td>
                <Td className={`text-right ${d.cls}`}>{d.text}</Td>
                <Td className="text-center mono">{fmtRate(r.after3yRate)}%</Td>
                <Td className="text-right mono">{formatTerm(r.payoffMonths)}</Td>{/* ← ใช้ payoffMonths */}
                <Td className="text-right mono">{fmtMoney(r.totalInterestAll)}</Td>
                <Td className="text-center"><button className="btn-secondary whitespace-nowrap" onClick={()=>onOpenSchedule(r.index)}>ดูงวด</button></Td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------- Schedule view (เดิม) ----------
const TH_MONTHS = ["ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."];
function addMonthsYM(ym, add){ const [y,m]=ym.split("-").map(Number); const d=new Date(y, m-1+add, 1); const mm=String(d.getMonth()+1).padStart(2,"0"); return `${d.getFullYear()}-${mm}`; }
function thaiMonthLabel(ym){ const [y,m]=ym.split("-").map(Number); return `${TH_MONTHS[m-1]} ${y+543}`; }

function ScheduleView({ bank }){
  const planned = Math.round(bank.termYears*12);
  const [startYM, setStartYM] = useState(()=>{
    const d=new Date(); const y=d.getFullYear(); const m=String(d.getMonth()+1).padStart(2,"0"); return `${y}-${m}`;
  });

  const schedule = useMemo(()=>buildSchedule({
    principal: bank.principal,
    termMonths: planned,
    rateSchedule: [
      { months:12, rateYear: bank.rate1 },
      { months:12, rateYear: bank.rate2 },
      { months:12, rateYear: bank.rate3 },
      { months: Math.max(0, planned-36), rateYear: bank.rateAfter },
    ],
    monthlyPaymentOverride: bank.monthlyOverride,
    prepayPct: bank.prepayPct || 0,
  }), [bank, planned]);

  const totalI = schedule.totalInterest;
  const totalP = schedule.rows.reduce((s,r)=>s + r.principalTotal, 0);

  const downloadCSV = ()=>{
    const header = ["เดือน","งวด","อัตราดอกเบี้ย(%)","ค่างวด","โปะเพิ่ม","เงินต้น","เงินต้นรวม","ดอกเบี้ย","คงเหลือ"].join(",");
    const body = schedule.rows.map((r, idx)=>[
      thaiMonthLabel(addMonthsYM(startYM, idx)),
      r.index,
      fmtRate(r.rate),
      r.payment.toFixed(2),
      r.extraPrepay.toFixed(2),
      r.principal.toFixed(2),
      r.principalTotal.toFixed(2),
      r.interest.toFixed(2),
      r.endBalance.toFixed(2),
    ].join(",")).join("\n");
    const csv = header+"\n"+body;
    const blob=new Blob([csv],{type:"text/csv;charset=utf-8;"}); const url=URL.createObjectURL(blob);
    const a=document.createElement("a"); a.href=url; a.download=`${bank.name}-schedule.csv`; a.click(); URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-lg font-semibold">ตารางผ่อน: {bank.name}</div>
        <div className="flex items-center gap-2">
          <label className="text-sm text-gray-600">เริ่มเดือน:</label>
          <input type="month" className="ipt mono" value={startYM} onChange={(e)=>setStartYM(e.target.value)} />
          <button className="btn" onClick={downloadCSV}>ดาวน์โหลด CSV</button>
        </div>
      </div>
      <div className="text-sm text-gray-600">
        รวมเงินต้นที่ชำระ (รวมโปะ): <span className="mono">{fmtMoney(totalP)}</span> บาท •
        รวมดอกเบี้ยตลอดสัญญา: <span className="mono">{fmtMoney(totalI)}</span> บาท
      </div>

      <div className="table-wrap" style={{maxHeight:"65vh"}}>
        <table className="min-w-full text-sm">
          <thead>
            <tr>
              <Th>เดือน</Th>
              <Th>งวด</Th>
              <Th className="text-right">อัตรา(%)</Th>
              <Th className="text-right">ค่างวด</Th>
              <Th className="text-right">โปะเพิ่ม</Th>
              <Th className="text-right">เงินต้น</Th>
              <Th className="text-right">เงินต้นรวม</Th>
              <Th className="text-right">ดอกเบี้ย</Th>
              <Th className="text-right">คงเหลือ</Th>
            </tr>
          </thead>
          <tbody>
            {schedule.rows.map((r, idx)=>(
              <tr key={r.index}>
                <Td className="mono">{thaiMonthLabel(addMonthsYM(startYM, idx))}</Td>
                <Td className="mono">{r.index}</Td>
                <Td className="text-right mono">{fmtRate(r.rate)}</Td>
                <Td className="text-right mono">{fmtMoney(r.payment)}</Td>
                <Td className="text-right mono">{fmtMoney(r.extraPrepay)}</Td>
                <Td className="text-right mono">{fmtMoney(r.principal)}</Td>
                <Td className="text-right mono">{fmtMoney(r.principalTotal)}</Td>
                <Td className="text-right mono">{fmtMoney(r.interest)}</Td>
                <Td className="text-right mono">{fmtMoney(r.endBalance)}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------- App (เพิ่มย้ายลำดับ) ----------
function App(){
  const [banks, setBanks] = useLocalState("mortgage-banks", DEFAULT_BANKS);
  const [route, setRoute] = useState(window.location.hash || "#/");

  useEffect(()=>{ const onHash=()=>setRoute(window.location.hash||"#/"); window.addEventListener("hashchange", onHash); return ()=>window.removeEventListener("hashchange", onHash); },[]);

  const goHome = ()=>{ window.location.hash="#/"; };
  const openSchedule = (i)=>{ window.location.hash=`#/schedule/${i}`; };

  const addBank = ()=>setBanks([...banks, {
    name:`ตัวเลือกใหม่ #${banks.length+1}`,
    principal: banks[0]?.principal ?? 2000000,
    termYears: banks[0]?.termYears ?? 20,
    rate1:3.500, rate2:3.800, rate3:4.000, rateAfter:6.500,
    monthlyOverride:null, prepayPct:0.000,
    otherCosts:{ MRTA:0,"ค่าประเมิน":0,"ค่าจดจำนอง":0,"ค่าธรรมเนียม":0,"ค่าปรับปิดก่อน":0 },
  }]);

  const removeBank = (i)=>setBanks(banks.filter((_,idx)=>idx!==i));
  const updateBank = (i,next)=>setBanks(banks.map((b,idx)=>(idx===i? next: b)));

  // ย้ายลำดับ
  const moveBank = (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= banks.length) return;
    const arr = banks.slice();
    [arr[i], arr[j]] = [arr[j], arr[i]];
    setBanks(arr);
  };

  const isSchedule = route.startsWith("#/schedule/");
  let scheduleIndex = null; if(isSchedule){ const parts=route.split("/"); scheduleIndex=+parts[2]; }

  return (
    <div className="max-w-6xl mx-auto p-4 md:p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <div className="w-9 h-9 rounded-2xl bg-gray-900 text-white grid place-items-center"><span className="mono">≡</span></div>
          <div>
            <div className="text-xl font-bold text-gray-900">ตัวช่วยเทียบรีไฟแนนซ์บ้าน</div>
            <div className="text-xs text-gray-500">ใส่ดอกเบี้ยปี 1–3, ค่างวดจริง, ค่าใช้จ่าย และโปะเพิ่ม (%)</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn" onClick={addBank} title="เพิ่มธนาคาร">＋ เพิ่มธนาคาร</button>
        </div>
      </div>

      {!isSchedule && (
        <div className="space-y-6">
          <div className="space-y-4">
            {banks.map((b,i)=>(
              <BankEditor
                key={i}
                bank={b}
                onChange={(next)=>updateBank(i,next)}
                onRemove={()=>removeBank(i)}
                onMoveUp={()=>moveBank(i,-1)}
                onMoveDown={()=>moveBank(i,+1)}
              />
            ))}
          </div>

          <div className="space-y-3">
            <div className="flex items-center gap-2 text-lg font-semibold text-gray-900">
              สรุปเทียบ (โฟกัสดอกเบี้ยรวม 3 ปี + ค่าใช้จ่ายอื่น) — พร้อมจำนวนงวดและดอกเบี้ยรวมทั้งสัญญา
            </div>
            <CompareTable banks={banks} onOpenSchedule={openSchedule}/>
            <div className="text-xs text-gray-500">
              หมายเหตุ: ระบบจะคำนวณค่างวดใหม่เมื่ออัตราดอกเบี้ยเปลี่ยนทุกช่วง เพื่อคงอายุสัญญาเดิม •
              “โปะเพิ่ม (%)” จะถูกคิดเป็นเปอร์เซ็นต์ของค่างวดแต่ละงวด แล้วนำไปตัดเงินต้นทันที
            </div>
          </div>
        </div>
      )}

      {isSchedule && banks[scheduleIndex] && (
        <div className="space-y-4">
          <button className="btn-secondary" onClick={goHome}>← กลับ</button>
          <ScheduleView bank={banks[scheduleIndex]} />
        </div>
      )}
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<App />);
