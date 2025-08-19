const { useMemo, useState, useEffect, useRef } = React;

/* ========== Utils ========== */
const toNumber = (v) => (isFinite(+v) ? +v : 0);
const clamp2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const clamp3 = (n) => Math.round((n + Number.EPSILON) * 1000) / 1000;
function pmt(r, n, P){ if(r===0) return P/n; const a=Math.pow(1+r,n); return (P*r*a)/(a-1); }
const genId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`;
const fmtMoney = (n)=> Number(n||0).toLocaleString("th-TH",{minimumFractionDigits:2, maximumFractionDigits:2});
const fmtRate = (n)=> Number(n||0).toFixed(3);
function parseMoneyInput(str){ if(str==null) return 0; const v=Number(String(str).replace(/,/g,"").trim()); return isFinite(v)?v:0; }
function formatMoneyInput(v){ if(v===""||v==null) return ""; return fmtMoney(v); }

/* ========== Core amortization ========== */
/** คำนวณแบบ "ตรึงค่างวดในแต่ละช่วงดอก" (ค่าเริ่มต้น) */
function buildSchedule({
  principal,
  termMonths,
  rateSchedule,                 // [{months:12, rateYear:...}, ...]
  monthlyPaymentOverride = null,
  prepayPct = 0,                // โปะเพิ่มเป็น % ของค่างวด
  capPerMonth = null,           // เพดาน (ค่างวด+โปะ/ลงทุน) ต่อเดือน
  installmentMode = "fixPerBlock" // เผื่ออนาคต (ตอนนี้ใช้ fixPerBlock)
}){
  let balance = principal;
  const rows = [];

  // กระจายเดือน + หมายเลขบล็อก
  const months=[];
  for(let bi=0; bi<rateSchedule.length; bi++){
    const {months:mCnt, rateYear} = rateSchedule[bi];
    for(let k=0; k<mCnt; k++) months.push({blockIndex:bi, rYear:rateYear});
  }
  months.length = Math.min(termMonths, months.length);

  let i=0;
  while(i<months.length && balance>0){
    const curBlock = months[i].blockIndex;
    const r = (months[i].rYear/100)/12;

    // ความยาวบล็อกจากตำแหน่งปัจจุบัน
    let blockLen=0; for(let j=i;j<months.length;j++){ if(months[j].blockIndex!==curBlock) break; blockLen++; }
    let remaining = months.length - i;

    // PMT ตรึงในบล็อก (คำนวณจาก "ยอดคงเหลือ" และ "อายุสัญญาที่เหลือ")
    const basePay = monthlyPaymentOverride
      ? monthlyPaymentOverride
      : (r===0 ? balance/remaining : (balance*r*Math.pow(1+r,remaining))/(Math.pow(1+r,remaining)-1));

    for(let k=0;k<blockLen && balance>0;k++){
      const interest = balance * r;
      let principalPay = Math.max(0, basePay - interest);

      // โปะจาก % ของค่างวด
      const desiredExtra = Math.max(0, basePay*(prepayPct/100));
      let allowedExtra = desiredExtra, extraCapped=false;
      if(capPerMonth && capPerMonth>0){
        const room = Math.max(0, capPerMonth - basePay);
        if(desiredExtra > room + 1e-9){ allowedExtra = room; extraCapped=true; }
      }

      let principalAll = principalPay + allowedExtra;
      if(principalAll > balance || remaining===1) principalAll = balance;

      const endBalance = Math.max(0, balance - principalAll);
      rows.push({
        index: rows.length+1,
        rate: months[i+k].rYear,
        payment: basePay,
        extraPrepay: allowedExtra,
        principal: principalPay,
        principalTotal: principalAll,
        interest,
        endBalance,
        extraCapped
      });

      balance = endBalance; remaining -= 1;
      if(balance<=0) break;
    }
    i += blockLen;
  }

  const totalInterest = rows.reduce((s,r)=>s+r.interest,0);
  const totalPayment  = rows.reduce((s,r)=>s+r.payment+r.extraPrepay,0);
  return { rows, totalInterest, totalPayment, endBalance: balance };
}
function sumOtherCosts(otherCosts){ return Object.values(otherCosts||{}).reduce((s,v)=>s+Number(v||0),0); }

/* ========== คำนวณ "ลงทุนรายเดือน+ทบต้นรายเดือน" ========== */
function computeInvestmentSeriesMonthly(baseRows, investPct, capPerMonth, expectReturnYear){
  const rM = Math.pow(1 + (Number(expectReturnYear||0)/100), 1/12) - 1; // ผลตอบแทน/เดือน
  let investValue = 0;   // มูลค่าพอร์ต ณ สิ้นเดือน
  let cumInvest   = 0;   // เงินต้นที่ลงสะสม
  const perYear   = [];
  let capHitThisYear = false;

  for(let m=0; m<baseRows.length; m++){
    const pay = baseRows[m].payment || 0;
    const desired = Math.max(0, pay*(Number(investPct||0)/100));
    let allowed  = desired;

    if(capPerMonth && capPerMonth>0){
      const room = Math.max(0, capPerMonth - pay);
      if(desired > room + 1e-9){ allowed = room; capHitThisYear = true; }
    }

    // เติมเงินก้อนเดือนนี้ก่อน แล้วค่อยปิดเดือนด้วยดอก/เดือน
    investValue += allowed;
    cumInvest   += allowed;
    investValue *= (1 + rM);

    const endOfYear = ((m+1)%12===0) || (m===baseRows.length-1);
    if(endOfYear){
      const yearIndex = Math.floor(m/12)+1;
      const profit = Math.max(0, investValue - cumInvest);
      perYear.push({
        yearIndex,
        investValue,
        investProfit: profit,
        cumInvest,
        capHitInvest: capHitThisYear
      });
      capHitThisYear = false;
    }
  }
  return perYear;
}

/* ========== Inputs ========== */
function MoneyInput({ value, onChange, placeholder }) {
  const [txt, setTxt] = useState(value===null?"":formatMoneyInput(value));
  useEffect(()=> setTxt(value===null?"":formatMoneyInput(value)), [value]);
  const onInput = (e)=> setTxt(e.target.value.replace(/[^0-9.,]/g,""));
  const onBlur = ()=>{ const v=clamp2(parseMoneyInput(txt)); onChange(v); setTxt(txt.trim()===""?"":formatMoneyInput(v)); };
  const onFocus = (e)=>{ const v=parseMoneyInput(txt); e.target.value = v? String(v):""; };
  return <input type="text" inputMode="decimal" className="ipt ipt-num mono" placeholder={placeholder||""} defaultValue={txt} onInput={onInput} onBlur={onBlur} onFocus={onFocus} />;
}
function RateInput({ value, onChange }){
  const [txt, setTxt] = useState(value===null?"":Number(value).toFixed(3));
  useEffect(()=> setTxt(value===null?"":Number(value).toFixed(3)), [value]);
  const onInput=(e)=> setTxt(e.target.value.replace(/[^0-9.]/g,""));
  const onBlur=()=>{ const v=clamp3(parseMoneyInput(txt)); onChange(v); setTxt(txt.trim()===""?"":Number(v).toFixed(3)); };
  const onFocus=(e)=>{ const v=parseMoneyInput(txt); e.target.value = v? String(v):""; };
  return <input type="text" inputMode="decimal" className="ipt ipt-num mono" defaultValue={txt} onInput={onInput} onBlur={onBlur} onFocus={onFocus} />;
}

/* ========== Defaults ========== */
const DEFAULT_BANKS = [
  // ยกเลิก default monthlyOverride เพื่อให้ค่างวดเปลี่ยนตามบล็อกดอกอัตโนมัติ
  { id: genId(), name:"กรุงศรี (ปัจจุบัน)", principal:2623000, termYears:20, rate1:5.37, rate2:5.37, rate3:5.37, rateAfter:5.37, monthlyOverride:null, prepayPct:0.0, otherCosts:{ MRTA:0,"ค่าประเมิน":0,"ค่าจดจำนอง":0,"ค่าธรรมเนียม":0,"ค่าปรับปิดก่อน":0 } },
  { id: genId(), name:"ออมสิน (โปร Q3/2568)", principal:2623000, termYears:20, rate1:1.99, rate2:3.805, rate3:3.805, rateAfter:6.37, monthlyOverride:null, prepayPct:0.0, otherCosts:{ MRTA:0,"ค่าประเมิน":0,"ค่าจดจำนอง":0,"ค่าธรรมเนียม":1000,"ค่าปรับปิดก่อน":0 } },
];

/* ========== helpers ========== */
function L({ label, children }){ return (<label className="block text-sm"><div className="text-gray-600 mb-1">{label}</div>{children}</label>); }
function Th({ children, className="" }){ return <th className={`text-left ${className}`}>{children}</th>; }
function Td({ children, className="" }){ return <td className={`align-top ${className}`}>{children}</td>; }
function formatTerm(termMonths){ const y=Math.floor(termMonths/12), m=termMonths%12; return `${termMonths} งวด (${y} ปี${m?" "+m+" เดือน":""})`; }

/* ========== refinance schedule ========== */
function makeRateSchedule(bank, termMonths, behavior){
  const block3=[bank.rate1, bank.rate2, bank.rate3];
  const block5=[bank.rate1, bank.rate2, bank.rate3, bank.rateAfter, bank.rateAfter];
  let pattern;
  if(behavior==="every3y") pattern=block3;
  else if(behavior==="every5y") pattern=block5;
  else pattern=[bank.rate1, bank.rate2, bank.rate3, ...Array(Math.max(0, Math.ceil(termMonths/12)-3)).fill(bank.rateAfter)];

  if(behavior==="none"){
    const arr=[ {months:12, rateYear:bank.rate1}, {months:12, rateYear:bank.rate2}, {months:12, rateYear:bank.rate3} ];
    const rest=Math.max(0, termMonths-36); if(rest>0) arr.push({months:rest, rateYear:bank.rateAfter}); return arr;
  }
  const blocks=[]; let left=termMonths;
  while(left>0){ for(let i=0;i<pattern.length && left>0;i++){ const len=Math.min(12,left); blocks.push({months:len, rateYear:pattern[i]}); left-=len; } }
  return blocks;
}

/* ========== Editor ========== */
function BankEditor({ bank, onChange, onRemove, onMoveUp, onMoveDown }){
  const handle=(f,v)=> onChange({ ...bank, [f]: v });
  const handleCost=(k,v)=> onChange({ ...bank, otherCosts:{ ...(bank.otherCosts||{}), [k]:v } });

  return (
    <div className="card mb-4">
      <div className="flex items-center justify-between mb-2">
        <input className="text-lg font-semibold outline-none border-b border-gray-300 px-1 bg-transparent" value={bank.name} onChange={e=>handle("name", e.target.value)} />
        <div className="flex items-center gap-2">
          <button className="btn-secondary" onClick={onMoveUp} title="ย้ายขึ้น" aria-label="Move up">↑ ย้ายขึ้น</button>
          <button className="btn-secondary" onClick={onMoveDown} title="ย้ายลง" aria-label="Move down">↓ ย้ายลง</button>
          <button className="btn-secondary" onClick={onRemove} title="ลบธนาคาร" aria-label="Remove bank">ลบธนาคาร</button>
        </div>
      </div>

      <div className="grid md:grid-cols-4 grid-cols-2 gap-3">
        <L label="ยอดกู้ (บาท)"><MoneyInput value={bank.principal} onChange={(v)=>handle("principal", v)} /></L>
        <L label="อายุสัญญา (ปี)"><MoneyInput value={bank.termYears} onChange={(v)=>handle("termYears", v)} /></L>
        <L label="ดอกเบี้ยปี 1 (%)"><RateInput value={bank.rate1} onChange={(v)=>handle("rate1", v)} /></L>
        <L label="ดอกเบี้ยปี 2 (%)"><RateInput value={bank.rate2} onChange={(v)=>handle("rate2", v)} /></L>
        <L label="ดอกเบี้ยปี 3 (%)"><RateInput value={bank.rate3} onChange={(v)=>handle("rate3", v)} /></L>
        <L label="หลังครบ 3 ปี (%)"><RateInput value={bank.rateAfter} onChange={(v)=>handle("rateAfter", v)} /></L>
        <L label="ค่างวด/เดือน (แก้ไขได้)"><MoneyInput value={bank.monthlyOverride===null? null: bank.monthlyOverride} onChange={(v)=>handle("monthlyOverride", v)} placeholder="คำนวณอัตโนมัติ" /></L>
        <L label="โปะเพิ่มต่องวด (%)"><RateInput value={bank.prepayPct} onChange={(v)=>handle("prepayPct", v)} /></L>
      </div>

      <div className="mt-4">
        <div className="text-sm font-medium mb-2 text-gray-700">ค่าใช้จ่ายอื่น ๆ (บาท) — ใส่เท่าที่มี</div>
        <div className="grid md:grid-cols-6 grid-cols-2 gap-3">
          {Object.entries(bank.otherCosts||{ MRTA:0,"ค่าประเมิน":0,"ค่าจดจำนอง":0,"ค่าธรรมเนียม":0,"ค่าปรับปิดก่อน":0 }).map(([k,v])=>(
            <L key={k} label={k}><MoneyInput value={v} onChange={(val)=>handleCost(k, val)} /></L>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ========== Compare Table ========== */
function CompareTable({ banks, refinanceBehavior, onOpenSchedule, onToggleFocus, showFocus }){
  const rows = useMemo(()=> banks.map((b,idx)=>{
    const planned=Math.round(b.termYears*12);
    const schedule=buildSchedule({
      principal:b.principal, termMonths:planned,
      rateSchedule:makeRateSchedule(b, planned, refinanceBehavior),
      monthlyPaymentOverride:b.monthlyOverride, prepayPct:b.prepayPct||0, installmentMode:"fixPerBlock"
    });
    const payoffMonths=schedule.rows.length, first36=schedule.rows.slice(0,36), first60=schedule.rows.slice(0,60);
    const int3y=first36.reduce((s,r)=>s+r.interest,0), prepay3y=first36.reduce((s,r)=>s+(r.extraPrepay||0),0);
    const int5y=first60.reduce((s,r)=>s+r.interest,0), prepay5y=first60.reduce((s,r)=>s+(r.extraPrepay||0),0);
    const other=sumOtherCosts(b.otherCosts), total3y=int3y+other, total5y=int5y+other;

    // ทำ "ขั้นบันไดค่างวด" จากการเปลี่ยนอัตราดอกแต่ละบล็อก
    const stepPays=[];
    let lastPay=null;
    for(const r of schedule.rows){
      const pay=Math.round(r.payment); // ปัดเพื่อจับการเปลี่ยน
      if(lastPay===null || Math.abs(pay-lastPay)>1){
        stepPays.push(pay);
        lastPay=pay;
      }
      // พอเกิน 4 ช่วงก็พอสำหรับการแสดง
      if(stepPays.length>=4) break;
    }
    const stepText = stepPays.map(v=>fmtMoney(v)).join(" → ");

    return {
      id:b.id, index:idx, name:b.name,
      stepText,
      prepay3y, interest3y:int3y, total3y,
      prepay5y, interest5y:int5y, total5y,
      after3yRate:b.rateAfter, payoffMonths,
      totalInterestAll:schedule.totalInterest, otherCosts:other
    };
  }), [banks, refinanceBehavior]);

  const currentBase = rows[0]?.total3y ?? null;
  const best3 = rows.length ? Math.min(...rows.map(r=>r.total3y)) : null;
  const worst3 = rows.length ? Math.max(...rows.map(r=>r.total3y)) : null;
  const best5 = rows.length ? Math.min(...rows.map(r=>r.total5y)) : null;
  const worst5 = rows.length ? Math.max(...rows.map(r=>r.total5y)) : null;

  const fmtDelta=(r)=>{ if(r.index===0||currentBase===null) return {text:"–", cls:""}; const d=r.total3y-currentBase; if(Math.abs(d)<0.005) return {text:"0.00", cls:""}; if(d>0) return {text:`(${fmtMoney(d)})`, cls:"text-red mono text-right"}; return {text:`${fmtMoney(Math.abs(d))}`, cls:"text-green mono text-right"}; };

  const table = (
    <div className="table-wrap">
      <table className="min-w-full text-sm">
        <thead>
          <tr>
            <Th>ธนาคาร</Th>
            <Th className="text-right">ค่างวด/เดือน (ตามบล็อกดอก)</Th>
            <Th className="text-right">โปะรวม 3 ปี</Th>
            <Th className="text-right">ดอกเบี้ยรวม 3 ปี</Th>
            <Th className="text-right">ค่าใช้จ่ายอื่น ๆ</Th>
            <Th className="text-right">รวม 3 ปี</Th>
            <Th className="text-right">เทียบธนาคารปัจจุบัน</Th>
            <Th className="text-center">ดอกเบี้ยหลัง 3 ปี</Th>
            <Th className="text-right">โปะรวม 5 ปี</Th>
            <Th className="text-right">ดอกเบี้ยรวม 5 ปี</Th>
            <Th className="text-right">รวม 5 ปี</Th>
            <Th className="text-right">จำนวนงวดที่เหลือ</Th>
            <Th className="text-right">ดอกเบี้ยรวมทั้งสัญญา</Th>
            <Th className="text-center">ตารางผ่อน</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r=>{
            const d=fmtDelta(r), cls3=r.total3y===best3?"cell-min":r.total3y===worst3?"cell-max":"", cls5=r.total5y===best5?"cell-min":r.total5y===worst5?"cell-max":"";
            return (
              <tr key={r.id}>
                <Td>{r.name}</Td>
                <Td className="text-right font-medium mono" title="ขั้นบันไดยอดผ่อนต่อเดือน">{r.stepText||"—"}</Td>
                <Td className="text-right mono">{fmtMoney(r.prepay3y)}</Td>
                <Td className="text-right mono">{fmtMoney(r.interest3y)}</Td>
                <Td className="text-right mono">{fmtMoney(r.otherCosts)}</Td>
                <Td className="text-right font-semibold mono"><span className={cls3}>{fmtMoney(r.total3y)}</span></Td>
                <Td className={`text-right ${d.cls}`}>{d.text}</Td>
                <Td className="text-center mono">{fmtRate(r.after3yRate)}%</Td>
                <Td className="text-right mono">{fmtMoney(r.prepay5y)}</Td>
                <Td className="text-right mono">{fmtMoney(r.interest5y)}</Td>
                <Td className="text-right font-semibold mono"><span className={cls5}>{fmtMoney(r.total5y)}</span></Td>
                <Td className="text-right mono">{formatTerm(r.payoffMonths)}</Td>
                <Td className="text-right mono">{fmtMoney(r.totalInterestAll)}</Td>
                <Td className="text-center"><button className="btn-secondary" onClick={()=>onOpenSchedule(r.index)} aria-label="Open schedule">ดูงวด</button></Td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="relative">
      <div className="flex items-center justify-between mb-2">
        <div className="text-lg font-semibold">สรุปเทียบ (3 ปี / 5 ปี)</div>
        <button className="btn-secondary" title="ขยายเต็มจอ (Focus mode)" onClick={onToggleFocus} aria-label="Expand">⛶ ขยาย</button>
      </div>
      {table}
      {showFocus && (
        <div className="focus-layer" onClick={onToggleFocus}>
          <div className="focus-box" onClick={(e)=>e.stopPropagation()}>
            <div className="focus-head"><div className="font-semibold">Compare — โหมดเต็มหน้าจอ</div><button className="focus-close" onClick={onToggleFocus}>✕ ปิด</button></div>
            <div className="focus-body">{table}</div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ========== Schedule View ========== */
const TH_MONTHS=["ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."];
function addMonthsYM(ym, add){ const [y,m]=ym.split("-").map(Number); const d=new Date(y, m-1+add, 1); const mm=String(d.getMonth()+1).padStart(2,"0"); return `${d.getFullYear()}-${mm}`; }
function thaiMonthLabel(ym){ const [y,m]=ym.split("-").map(Number); return `${TH_MONTHS[m-1]} ${y+543}`; }

function ScheduleView({ bank, refinanceBehavior }){
  const planned=Math.round(bank.termYears*12);
  const [startYM, setStartYM]=useState(()=>{ const d=new Date(); const y=d.getFullYear(); const m=String(d.getMonth()+1).padStart(2,"0"); return `${y}-${m}`; });

  const schedule=useMemo(()=> buildSchedule({
    principal:bank.principal, termMonths:planned,
    rateSchedule:makeRateSchedule(bank, planned, refinanceBehavior),
    monthlyPaymentOverride:bank.monthlyOverride, prepayPct:bank.prepayPct||0, installmentMode:"fixPerBlock"
  }), [bank, planned, refinanceBehavior]);

  const totalI=schedule.totalInterest, totalP=schedule.rows.reduce((s,r)=>s+r.principalTotal,0);

  const exportCSV=()=>{ const header=["เดือน","งวด","อัตราดอกเบี้ย(%)","ค่างวด","โปะเพิ่ม","เงินต้น","เงินต้นรวม","ดอกเบี้ย","คงเหลือ"].join(","); const body=schedule.rows.map((r,idx)=>[thaiMonthLabel(addMonthsYM(startYM, idx)), r.index, fmtRate(r.rate), r.payment.toFixed(2), r.extraPrepay.toFixed(2), r.principal.toFixed(2), r.principalTotal.toFixed(2), r.interest.toFixed(2), r.endBalance.toFixed(2)].join(",")).join("\r\n"); const csv="\uFEFF"+header+"\r\n"+body; const blob=new Blob([csv],{type:"text/csv;charset=utf-8;"}); const url=URL.createObjectURL(blob); const a=document.createElement("a"); a.href=url; a.download=`${bank.name}-schedule.csv`; a.click(); URL.revokeObjectURL(url); };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-lg font-semibold">ตารางผ่อน: {bank.name}</div>
        <div className="flex items-center gap-2">
          <label className="text-sm text-gray-600">เริ่มเดือน:</label>
          <input type="month" className="ipt mono" value={startYM} onChange={(e)=>setStartYM(e.target.value)} />
          <button className="btn" onClick={exportCSV} aria-label="Export schedule">Export</button>
        </div>
      </div>
      <div className="text-sm text-gray-600">
        รวมเงินต้นที่ชำระ (รวมโปะ): <span className="mono">{fmtMoney(totalP)}</span> บาท • รวมดอกเบี้ยตลอดสัญญา: <span className="mono">{fmtMoney(totalI)}</span> บาท
      </div>

      <div className="table-wrap" style={{maxHeight:"65vh"}}>
        <table className="min-w-full text-sm">
          <thead>
            <tr>
              <Th>เดือน</Th><Th>งวด</Th>
              <Th className="text-right">อัตรา(%)</Th><Th className="text-right">ค่างวด</Th>
              <Th className="text-right">โปะเพิ่ม</Th><Th className="text-right">เงินต้น</Th>
              <Th className="text-right">เงินต้นรวม</Th><Th className="text-right">ดอกเบี้ย</Th>
              <Th className="text-right">คงเหลือ</Th>
            </tr>
          </thead>
          <tbody>
            {schedule.rows.map((r,idx)=>(
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

/* ========== Dropdown Multi ========== */
function useOnClickOutside(ref, handler){
  useEffect(()=>{ const listener=(e)=>{ if(!ref.current || ref.current.contains(e.target)) return; handler(e); }; document.addEventListener('mousedown', listener); document.addEventListener('touchstart', listener); return ()=>{ document.removeEventListener('mousedown', listener); document.removeEventListener('touchstart', listener); }; },[ref, handler]);
}
function DropdownMulti({ label, options, valueIds, onToggle, max=3 }){
  const [open, setOpen]=useState(false); const ref=useRef(null);
  useOnClickOutside(ref, ()=> setOpen(false));
  const selected=options.filter(o=>valueIds.includes(o.id));
  const title = selected.length ? `${label}: ${selected.map(s=>s.name).join(", ").slice(0,60)}${selected.map(s=>s.name).join(", ").length>60?"…":""}` : label;
  return (
    <div className="dropdown" ref={ref}>
      <button className="btn-secondary ipt-sm" onClick={()=>setOpen(v=>!v)} title={title} aria-haspopup="listbox" aria-expanded={open}>{selected.length? `${label} (${selected.length}/${max})` : label}</button>
      {open && (
        <div className="dropdown-menu" role="listbox">
          {options.map(opt=>{
            const checked=valueIds.includes(opt.id); const disabled=!checked && valueIds.length>=max;
            return (
              <label key={opt.id} className="item text-sm">
                <input type="checkbox" checked={checked} disabled={disabled} onChange={()=>onToggle(opt.id)} />
                <span className={disabled?"text-gray-400":""}>{opt.name}</span>
              </label>
            );
          })}
          <div className="dropdown-footer">เลือกได้สูงสุด {max} ธนาคารสำหรับกราฟ</div>
        </div>
      )}
    </div>
  );
}

/* ========== Investment View ========== */
function InvestmentView({ banks, refinanceBehavior, onChangeRefiBehavior }){
  const [overridePrepayPct, setOverridePrepayPct] = useState("");
  const [monthlyCap, setMonthlyCap] = useState("");
  const [expectReturn, setExpectReturn] = useState("7");
  const [graphMode, setGraphMode] = useState("saved"); // 'saved' | 'total'
  const [showChart, setShowChart] = useState(false);
  const [selectedIds, setSelectedIds] = useState(()=> banks.slice(0,2).map(b=>b.id));
  useEffect(()=>{ if(selectedIds.length===0 && banks[0]) setSelectedIds([banks[0].id]); }, [banks]);
  const toggleSelect=(id)=> setSelectedIds(prev=>{ const has=prev.includes(id); let next = has? prev.filter(x=>x!==id) : [...prev, id]; if(next.length>3) next=next.slice(1); return next; });

  const canvasRef=useRef(null);

  /* ---- calc yearly ---- */
  const calcData = useMemo(()=> banks.map((b)=>{
    const termMonths=Math.round(b.termYears*12);
    const pctUse = (overridePrepayPct===""? (b.prepayPct||0) : Number(overridePrepayPct||0));
    const cap = Number(monthlyCap||0);

    // ตาราง "โปะจริง"
    const schedWith = buildSchedule({
      principal:b.principal, termMonths,
      rateSchedule:makeRateSchedule(b, termMonths, refinanceBehavior),
      monthlyPaymentOverride:b.monthlyOverride, prepayPct:pctUse, capPerMonth: cap>0? cap: null, installmentMode:"fixPerBlock"
    });

    // ตาราง "ไม่โปะ" (ฐานคำนวณผลประหยัดดอก และฐานเงินไปลงทุน)
    const schedBase = buildSchedule({
      principal:b.principal, termMonths,
      rateSchedule:makeRateSchedule(b, termMonths, refinanceBehavior),
      monthlyPaymentOverride:b.monthlyOverride, prepayPct:0, capPerMonth:null, installmentMode:"fixPerBlock"
    });

    // ลงทุนรายเดือน + ทบต้นรายเดือน
    const investSeries = computeInvestmentSeriesMonthly(schedBase.rows, pctUse, cap>0? cap: null, expectReturn);

    // รวมเป็นรายปี
    const years=Math.max(Math.ceil(schedWith.rows.length/12), Math.ceil(schedBase.rows.length/12));
    const perYear=[]; let cumInterestWith=0, cumInterestBase=0;

    for(let y=0;y<years;y++){
      const sw=schedWith.rows.slice(y*12,y*12+12), sb=schedBase.rows.slice(y*12,y*12+12);
      const interestWith=sw.reduce((s,row)=>s+row.interest,0), interestBase=sb.reduce((s,row)=>s+row.interest,0);
      cumInterestWith+=interestWith; cumInterestBase+=interestBase;

      const invY = investSeries[y] || { investValue:0, investProfit:0, cumInvest:0, capHitInvest:false };

      perYear.push({
        yearIndex: y+1,
        cumInterestWith,        // ดอกเบี้ยรวมสะสม (โปะ)
        cumInterestBase,        // ดอกเบี้ยรวมสะสม (ไม่โปะ)
        cumInvest: invY.cumInvest,
        investValue: invY.investValue,
        investProfit: invY.investProfit,
        savedInterestYear: Math.max(0, interestBase - interestWith),
        capHitInvest: invY.capHitInvest
      });
    }

    // series สำหรับกราฟ
    let cumSaved=0;
    const seriesSaved=[], seriesProfit=[], seriesTotWith=[], seriesTotBase=[];
    perYear.forEach(y=>{
      cumSaved += y.savedInterestYear;
      seriesSaved.push(cumSaved);
      seriesProfit.push(y.investProfit);
      seriesTotWith.push(y.cumInterestWith);
      seriesTotBase.push(y.cumInterestBase);
    });

    return { id:b.id, name:b.name, years:perYear, chartSeries:{ saved:seriesSaved, profit:seriesProfit, totWith:seriesTotWith, totBase:seriesTotBase } };
  }), [banks, overridePrepayPct, monthlyCap, expectReturn, refinanceBehavior]);

  const maxYears = Math.max(0, ...calcData.map(d=>d.years.length));

  /* ---- chart ---- */
  useEffect(()=>{ if(!showChart) return;
    const canvas=canvasRef.current; if(!canvas) return; const ctx=canvas.getContext("2d"); const dpi=window.devicePixelRatio||1;
    const selected=calcData.filter(d=>selectedIds.includes(d.id)); if(selected.length===0) return;

    const colorPairs=[["#10b981","#047857"],["#3b82f6","#1d4ed8"],["#f59e0b","#b45309"]];
    const series=[], labels=[], colors=[];

    if(graphMode==="saved"){
      const len0=selected[0].chartSeries.saved.length;
      series.push(Array.from({length:len0},()=>0)); labels.push("Base (ไม่โปะ) — ประหยัดดอก = 0"); colors.push("#6b7280");
      selected.forEach((d,idx)=>{
        series.push(d.chartSeries.saved);  labels.push(`${d.name} — ดอกเบี้ยที่ประหยัดสะสม`); colors.push(colorPairs[idx%colorPairs.length][0]);
        series.push(d.chartSeries.profit); labels.push(`${d.name} — กำไรลงทุนสะสม`);     colors.push(colorPairs[idx%colorPairs.length][1]);
      });
    }else{ // 'total'
      selected.forEach((d,idx)=>{
        series.push(d.chartSeries.totBase); labels.push(`${d.name} — ดอกเบี้ยรวมสะสม (ไม่โปะ)`); colors.push("#6b7280");
        series.push(d.chartSeries.totWith); labels.push(`${d.name} — ดอกเบี้ยรวมสะสม (มีโปะ)`); colors.push(colorPairs[idx%colorPairs.length][0]);
        series.push(d.chartSeries.profit);  labels.push(`${d.name} — กำไรลงทุนสะสม`);       colors.push(colorPairs[idx%colorPairs.length][1]);
      });
    }

    function draw(hoverI=null){
      const W=canvas.clientWidth*dpi, H=canvas.clientHeight*dpi; canvas.width=W; canvas.height=H;
      const allY=series.flat(); const maxY=Math.max(1, ...allY);
      const pad=40*dpi, plotW=W-pad*2, plotH=H-pad*2;
      ctx.clearRect(0,0,W,H); ctx.fillStyle="#fff"; ctx.fillRect(0,0,W,H);

      // grid
      ctx.strokeStyle="#e5e7eb"; ctx.lineWidth=1; ctx.fillStyle="#6b7280"; ctx.font=`${12*dpi}px sans-serif`;
      for(let i=0;i<=5;i++){
        const y=pad + plotH*(i/5);
        ctx.beginPath(); ctx.moveTo(pad,y); ctx.lineTo(W-pad,y); ctx.stroke();
        const val=maxY*(1-i/5); ctx.fillText(fmtMoney(val), 6*dpi, y-4*dpi);
      }
      const lenX=series[0].length;
      for(let i=0;i<lenX;i++){ const x=pad + plotW*(i/Math.max(1, lenX-1)); ctx.fillText(`ปี ${i+1}`, x-10*dpi, H-8*dpi); }

      const xOf=(i,len)=> pad + plotW*(i/Math.max(1, len-1));
      const yOf=(v)=> pad + plotH*(1 - (v/maxY));

      series.forEach((arr,si)=>{
        ctx.beginPath();
        arr.forEach((v,i)=>{ const x=xOf(i,arr.length), y=yOf(v); if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y); });
        ctx.strokeStyle=colors[si]; ctx.lineWidth= si%3===0 && graphMode==="total" ? 1.2*dpi : 2*dpi;
        ctx.stroke();
      });

      // Legend
      const colW=360*dpi, startX=W-pad-colW, startY=pad;
      labels.forEach((lb,i)=>{ const y=startY + i*16*dpi; ctx.fillStyle=colors[i]; ctx.fillRect(startX,y,10*dpi,10*dpi); ctx.fillStyle="#111827"; ctx.fillText(lb, startX+14*dpi, y+10*dpi); });

      // Hover
      if(hoverI!==null){
        const xh=xOf(hoverI, series[0].length);
        ctx.strokeStyle="#9ca3af"; ctx.setLineDash([4*dpi,4*dpi]);
        ctx.beginPath(); ctx.moveTo(xh,pad); ctx.lineTo(xh,H-pad); ctx.stroke(); ctx.setLineDash([]);

        const vals=series.map(arr=>arr[hoverI]??0);
        vals.forEach((v,si)=>{ ctx.beginPath(); ctx.arc(xh, yOf(v), 3*dpi, 0, Math.PI*2); ctx.fillStyle=colors[si]; ctx.fill(); });

        const tip=[`ปี ${hoverI+1}`, ...labels.map((lb,i)=>`${lb}: ${fmtMoney(vals[i])} บ.`)];
        const boxW=420*dpi, boxH=(tip.length*16+12)*dpi;
        const boxX=Math.min(Math.max(pad, xh+12*dpi), W-pad-boxW), boxY=pad+8*dpi;
        ctx.fillStyle="rgba(17,24,39,0.92)"; ctx.fillRect(boxX,boxY,boxW,boxH);
        ctx.fillStyle="#fff"; ctx.font=`${12*dpi}px sans-serif`;
        tip.forEach((t,i)=> ctx.fillText(t, boxX+10*dpi, boxY+20*dpi+i*16*dpi));
      }
    }

    draw(null);
    const onMove=(e)=>{ const rect=canvas.getBoundingClientRect(); const x=(e.clientX-rect.left)*dpi; const W=canvas.width, pad=40*dpi, plotW=W-pad*2; const len=series[0].length||1; const t=Math.max(0, Math.min(1, (x-pad)/Math.max(1,plotW))); const idx=Math.round(t*(len-1)); draw(idx); };
    const onLeave=()=>draw(null);
    canvas.addEventListener("mousemove", onMove); canvas.addEventListener("mouseleave", onLeave);
    return ()=>{ canvas.removeEventListener("mousemove", onMove); canvas.removeEventListener("mouseleave", onLeave); };
  }, [showChart, calcData, selectedIds, graphMode]);

  const exportCSV=()=>{ 
    const header=["ธนาคาร","ปี","SavedInterestCum","InvestProfitCum","InvestPrincipalCum","InvestValueEnd","TotalInterestWith","TotalInterestBase","CapHit"].join(",");
    const body=calcData.map(d=> d.years.map((y,i)=>[
      d.name, y.yearIndex,
      (d.chartSeries.saved[i]||0).toFixed(2),
      (d.chartSeries.profit[i]||0).toFixed(2),
      y.cumInvest.toFixed(2),
      y.investValue.toFixed(2),
      (d.chartSeries.totWith[i]||0).toFixed(2),
      (d.chartSeries.totBase[i]||0).toFixed(2),
      y.capHitInvest?1:0
    ].join(",")).join("\r\n")).join("\r\n");
    const csv="\uFEFF"+header+"\r\n"+body; 
    const blob=new Blob([csv],{type:"text/csv;charset=utf-8;"}); 
    const url=URL.createObjectURL(blob); 
    const a=document.createElement("a"); a.href=url; a.download="investment_compare.csv"; a.click(); URL.revokeObjectURL(url); 
  };

  return (
    <div className="space-y-3 invest-wrap">
      <div className="invest-head">Investment (ต่อปี)</div>

      {/* controls: one line, scrollable horizontally */}
      <div className="controls-card" title="เลื่อนแนวนอนได้ถ้าพื้นที่ไม่พอ">
        <div className="group">
          <label className="text-xs text-gray-600">Refinance:</label>
          <select className="ipt ipt-sm" value={refinanceBehavior} onChange={(e)=>onChangeRefiBehavior(e.target.value)} aria-label="Refinance behavior">
            <option value="none">ไม่รีไฟแนนซ์</option>
            <option value="every3y">รีไฟแนนซ์ทุก 3 ปี</option>
            <option value="every5y">รีไฟแนนซ์ทุก 5 ปี</option>
          </select>
        </div>

        <DropdownMulti label="เลือกธนาคาร (กราฟ)" options={banks} valueIds={selectedIds} onToggle={toggleSelect} max={3} />

        <div className="group">
          <label className="text-xs text-gray-600">โหมดกราฟ:</label>
          <select className="ipt ipt-sm" value={graphMode} onChange={e=>setGraphMode(e.target.value)} aria-label="Graph mode">
            <option value="saved">ประหยัดดอกสะสม ↔ กำไรลงทุน</option>
            <option value="total">ดอกเบี้ยรวมสะสม ↔ กำไรลงทุน</option>
          </select>
        </div>

        <div className="group">
          <label className="text-xs text-gray-600">ลงทุนเพิ่ม (%)</label>
          <input className="ipt ipt-num ipt-sm mono" style={{width:90}} placeholder="เช่น 5" defaultValue={overridePrepayPct} onBlur={(e)=> setOverridePrepayPct(e.target.value.trim())}/>
        </div>

        <div className="group">
          <label className="text-xs text-gray-600">เพดาน/เดือน (บาท)</label>
          <input className="ipt ipt-num ipt-sm mono" style={{width:140}} placeholder="เช่น 16000" defaultValue={monthlyCap} onBlur={(e)=> setMonthlyCap(e.target.value.trim())}/>
        </div>

        <div className="group">
          <label className="text-xs text-gray-600">คาดหวังผลตอบแทน/ปี (%)</label>
          <input className="ipt ipt-num ipt-sm mono" style={{width:90}} placeholder="5–8" defaultValue={expectReturn} onBlur={(e)=> setExpectReturn(e.target.value.trim())}/>
        </div>

        <button className="btn-secondary ipt-sm" onClick={exportCSV} title="ส่งออกข้อมูลการลงทุน" aria-label="Export investment">Export</button>
        <button className="btn ipt-sm" onClick={()=>setShowChart(true)} title="ดูกราฟเปรียบเทียบ" aria-label="Open chart">ดูกราฟ</button>
      </div>

      {/* ตาราง */}
      <div className="table-wrap sticky-first" style={{ maxHeight:"75vh" }}>
        <table className="text-sm">
          <thead>
            <tr>
              <Th>ธนาคาร / รายการ</Th>
              {Array.from({length:maxYears},(_,i)=>(<Th key={i} className="text-right year-col">ปีที่ {i+1}</Th>))}
            </tr>
          </thead>
          <tbody>
            {calcData.map((d,di)=>(
              <React.Fragment key={d.id}>
                {di>0 && <tr className="bank-divider"><Td colSpan={maxYears+1}>{d.name}</Td></tr>}
                {di===0 && <tr className="bank-divider"><Td colSpan={maxYears+1}>{d.name}</Td></tr>}

                <tr>
                  <Td className="sub-label">ดอกเบี้ยรวมสะสม (กรณีมีโปะ)</Td>
                  {Array.from({length:maxYears},(_,i)=>(
                    <Td key={`ci-${di}-${i}`} className="text-right mono">{fmtMoney(d.years[i]?.cumInterestWith||0)}</Td>
                  ))}
                </tr>
                <tr>
                  <Td className="sub-label">ดอกเบี้ยรวมสะสม (ไม่โปะ)</Td>
                  {Array.from({length:maxYears},(_,i)=>(
                    <Td key={`cib-${di}-${i}`} className="text-right mono">{fmtMoney(d.years[i]?.cumInterestBase||0)}</Td>
                  ))}
                </tr>
                <tr>
                  <Td className="sub-label">เงินต้นลงทุนสะสม (ยอดลงทุนรายเดือน)</Td>
                  {Array.from({length:maxYears},(_,i)=>(
                    <Td key={`cumInv-${di}-${i}`} className={`text-right mono ${d.years[i]?.capHitInvest?"cap-alert":""}`}>{fmtMoney(d.years[i]?.cumInvest||0)}</Td>
                  ))}
                </tr>
                <tr>
                  <Td className="sub-label">มูลค่าพอร์ตลงทุน (สิ้นปี)</Td>
                  {Array.from({length:maxYears},(_,i)=>(
                    <Td key={`val-${di}-${i}`} className="text-right mono">{fmtMoney(d.years[i]?.investValue||0)}</Td>
                  ))}
                </tr>
                <tr>
                  <Td className="sub-label">กำไรลงทุนสะสม (แสดงในกราฟ)</Td>
                  {Array.from({length:maxYears},(_,i)=>(
                    <Td key={`profit-${di}-${i}`} className="text-right mono">{fmtMoney(d.chartSeries.profit[i]||0)}</Td>
                  ))}
                </tr>
                <tr><Td colSpan={maxYears+1} style={{height:6}}></Td></tr>
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <div className="text-xs text-gray-500">
        * ไฮไลท์เหลือง = ปีนั้นมีเดือนที่ “ค่างวด + เงินลงทุนตามที่ตั้ง” เกินเพดาน/เดือน •
        โหมดกราฟ “ประหยัดดอกสะสม” แสดง Base=0 ตามนิยาม •
        โหมด “ดอกเบี้ยรวมสะสม” ทำให้กราฟสอดคล้องกับตัวเลขในตารางรวมดอกเบี้ย
      </div>

      {showChart && (
        <div className="chart-modal" onClick={()=>setShowChart(false)}>
          <div className="chart-box" onClick={(e)=>e.stopPropagation()}>
            <div className="chart-head">
              <div className="font-semibold">
                กราฟเทียบหลายธนาคาร (แกน Y = บาท, แกน X = ปี) — โหมด: {graphMode==="saved"?"ประหยัดดอกสะสม":"ดอกเบี้ยรวมสะสม"}
              </div>
              <button className="focus-close" onClick={()=>setShowChart(false)}>✕ ปิด</button>
            </div>
            <div className="chart-body"><canvas ref={canvasRef}></canvas></div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ========== App ========== */
function useLocalState(key, initial){
  const [state, setState]=useState(()=>{ try{ const s=localStorage.getItem(key); return s? JSON.parse(s): initial; }catch{ return initial; } });
  useEffect(()=>{ localStorage.setItem(key, JSON.stringify(state)); },[key, state]);
  return [state, setState];
}

/* ไอคอน */
const IconDownload=()=>(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M12 3v12m0 0l-4-4m4 4l4-4"/><path d="M3 21h18"/></svg>);
const IconUpload=()=>(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M12 21V9m0 0l4 4m-4-4l-4 4"/><path d="M3 3h18"/></svg>);
const IconPlus=()=>(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>);

function App(){
  const [banks, setBanks]=useLocalState("mortgage-banks", DEFAULT_BANKS);
  const [route, setRoute]=useState(window.location.hash||"#/");
  const [focusCompare, setFocusCompare]=useState(false);
  const [refinanceBehavior, setRefinanceBehavior]=useState("none");
  const fileRef=React.useRef(null);

  useEffect(()=>{ setBanks(prev=>{ let changed=false; const fixed=(prev||[]).map(b=>(!b.id? (changed=true, {...b, id:genId()}): b)); return changed? fixed: prev; }); },[]);
  useEffect(()=>{ const onHash=()=> setRoute(window.location.hash||"#/"); window.addEventListener("hashchange", onHash); return ()=> window.removeEventListener("hashchange", onHash); },[]);

  const goHome=()=>{ window.location.hash="#/"; };
  const openSchedule=(i)=>{ window.location.hash=`#/schedule/${i}`; };
  const openInvest=()=>{ window.location.hash="#/invest"; };

  const addBank=()=> setBanks([...banks, { id:genId(), name:`ตัวเลือกใหม่ #${banks.length+1}`, principal:banks[0]?.principal??2000000, termYears:banks[0]?.termYears??20, rate1:3.5, rate2:3.8, rate3:4.0, rateAfter:6.5, monthlyOverride:null, prepayPct:0.0, otherCosts:{ MRTA:0,"ค่าประเมิน":0,"ค่าจดจำนอง":0,"ค่าธรรมเนียม":0,"ค่าปรับปิดก่อน":0 } }]);
  const removeBank=(i)=> setBanks(banks.filter((_,idx)=> idx!==i));
  const updateBank=(i,next)=> setBanks(banks.map((b,idx)=> idx===i? next: b));
  const moveBank=(i,dir)=>{ const j=i+dir; if(j<0||j>=banks.length) return; const arr=banks.slice(); [arr[i],arr[j]]=[arr[j],arr[i]]; setBanks(arr); };

  const onClickImport=()=> fileRef.current?.click();
  const onFileChange=async (e)=>{ const f=e.target.files?.[0]; if(!f) return; const text=await f.text(); const list=banksFromCSV(text); if(list.length===0){ alert("ไม่พบข้อมูลที่นำเข้า ตรวจสอบหัวตาราง/คอลัมน์อีกครั้ง"); return; } setBanks(list); e.target.value=""; };

  const isSchedule=route.startsWith("#/schedule/"); const isInvest=route==="#/invest"; let scheduleIndex=null; if(isSchedule){ const parts=route.split("/"); scheduleIndex=+parts[2]; }

  const downloadTemplateCSV=()=>{ 
    const header=["name","principal","termYears","rate1","rate2","rate3","rateAfter","monthlyOverride","prepayPct","MRTA","ค่าประเมิน","ค่าจดจำนอง","ค่าธรรมเนียม","ค่าปรับปิดก่อน"].join(",");
    const sample=[
      "กรุงศรี (ปัจจุบัน),2623000,20,5.37,5.37,5.37,5.37,,0,0,0,0,0,0",
      "ออมสิน (โปร Q3/2568),2623000,20,1.99,3.805,3.805,6.37,,0,0,0,0,1000,0"
    ].join("\r\n");
    const csv="\uFEFF"+header+"\r\n"+sample; 
    const blob=new Blob([csv],{type:"text/csv;charset=utf-8;"}); 
    const url=URL.createObjectURL(blob); const a=document.createElement("a");
    a.href=url; a.download="mortgage_template.csv"; a.click(); URL.revokeObjectURL(url);
  };

  return (
    <div className={`mx-auto ${isInvest? "p-2 md:p-3" : "p-4 md:p-6 max-w-6xl"}`}>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <div className="w-9 h-9 rounded-[10px] bg-gray-900 text-white grid place-items-center"><span className="mono">≡</span></div>
          <div>
            <div className="text-xl font-bold text-gray-900">ตัวช่วยเทียบรีไฟแนนซ์บ้าน</div>
            <div className="text-xs text-gray-500">ใส่ดอกเบี้ยปี 1–3, ค่างวดจริง, ค่าใช้จ่าย และโปะเพิ่ม (%)</div>
          </div>
        </div>

        {/* ขวาบน: แสดงเฉพาะหน้า Home (ไม่ซ้ำซ้อนกับหน้า Investment) */}
        {!isSchedule && !isInvest && (
          <div className="flex items-center gap-2">
            <label className="text-sm text-gray-600">Refinance:</label>
            <select className="ipt ipt-sm" value={refinanceBehavior} onChange={(e)=>setRefinanceBehavior(e.target.value)} aria-label="Refinance behavior">
              <option value="none">ไม่รีไฟแนนซ์</option>
              <option value="every3y">รีไฟแนนซ์ทุก 3 ปี</option>
              <option value="every5y">รีไฟแนนซ์ทุก 5 ปี</option>
            </select>

            <button className="btn-secondary ipt-sm" onClick={openInvest} title="Investment view" aria-label="Open Investment">Investment</button>

            <input ref={fileRef} type="file" accept=".csv" style={{display:"none"}} onChange={onFileChange}/>
            <button className="btn-secondary icon-btn" onClick={downloadTemplateCSV} title="ดาวน์โหลดเทมเพลต CSV (Download)" aria-label="Download template"><IconDownload/></button>
            <button className="btn-secondary icon-btn" onClick={onClickImport} title="นำเข้า CSV (Upload)" aria-label="Upload CSV"><IconUpload/></button>
            <button className="btn icon-btn" onClick={addBank} title="เพิ่มธนาคาร" aria-label="Add bank"><IconPlus/></button>
          </div>
        )}
      </div>

      {/* หน้าเปรียบเทียบหลัก */}
      {!isSchedule && !isInvest && (
        <div className="space-y-6">
          <div className="space-y-4">
            {banks.map((b,i)=>(
              <BankEditor key={b.id} bank={b} onChange={(next)=>updateBank(i,next)} onRemove={()=>removeBank(i)} onMoveUp={()=>moveBank(i,-1)} onMoveDown={()=>moveBank(i,+1)} />
            ))}
          </div>

          <div className="space-y-3">
            <CompareTable banks={banks} refinanceBehavior={refinanceBehavior} onOpenSchedule={openSchedule} onToggleFocus={()=>setFocusCompare(v=>!v)} showFocus={focusCompare} />
            <div className="text-xs text-gray-500">หมายเหตุ: ระบบตรึงค่างวดตามช่วงอัตราดอก (คำนวณใหม่เมื่อเปลี่ยนอัตรา) • “โปะเพิ่ม (%)” จะคิดจากค่างวดแล้วตัดเงินต้นทันที • ตัวเลือก “Refinance” จะวนอัตราดอกตามรอบที่เลือก</div>
          </div>
        </div>
      )}

      {/* Investment (เต็มกว้าง) */}
      {isInvest && (
        <div className="space-y-4">
          <div className="flex items-center"><button className="btn-secondary ipt-sm" onClick={goHome} aria-label="Back">← กลับ</button></div>
          <InvestmentView banks={banks} refinanceBehavior={refinanceBehavior} onChangeRefiBehavior={setRefinanceBehavior} />
        </div>
      )}

      {/* ตารางงวดรายเดือน */}
      {isSchedule && banks[scheduleIndex] && (
        <div className="space-y-4">
          <button className="btn-secondary ipt-sm" onClick={goHome} aria-label="Back">← กลับ</button>
          <ScheduleView bank={banks[scheduleIndex]} refinanceBehavior={refinanceBehavior} />
        </div>
      )}
    </div>
  );
}

/* ========== CSV helpers ========== */
function parseCSV(text){ const rows=[]; let i=0, field="", row=[], inQuotes=false;
  while(i<text.length){ const c=text[i];
    if(inQuotes){ if(c==='"'){ if(text[i+1]==='"'){ field+='"'; i+=2; continue;} inQuotes=false; i++; continue;} field+=c; i++; continue; }
    else{ if(c==='"'){ inQuotes=true; i++; continue;} if(c===','){ row.push(field.trim()); field=""; i++; continue;} if(c==='\n'||c=='\r'){ if(c=='\r'&&text[i+1]=='\n') i++; row.push(field.trim()); rows.push(row); field=""; row=[]; i++; continue;} field+=c; i++; continue; }
  }
  if(field.length>0||row.length>0){ row.push(field.trim()); rows.push(row); }
  return rows;
}
function banksFromCSV(csvText){
  const rows=parseCSV(csvText).filter(r=>r.length>0 && r.some(x=>x!=="")); if(rows.length===0) return [];
  const header=rows[0].map(h=>h.trim()); const idx=(name)=> header.findIndex(h=>h.toLowerCase()===name.toLowerCase());
  const col={ name:idx("name"), principal:idx("principal"), termYears:idx("termYears"), rate1:idx("rate1"), rate2:idx("rate2"), rate3:idx("rate3"), rateAfter:idx("rateAfter"), monthlyOverride:idx("monthlyOverride"), prepayPct:idx("prepayPct"), MRTA:idx("MRTA"), appr:header.findIndex(h=>h==="ค่าประเมิน"), reg:header.findIndex(h=>h==="ค่าจดจำนอง"), fee:header.findIndex(h=>h==="ค่าธรรมเนียม"), preclose:header.findIndex(h=>h==="ค่าปรับปิดก่อน") };
  const list=[]; for(let r=1;r<rows.length;r++){ const row=rows[r]; if(!row||row.length===0) continue; const val=(i)=> (i>=0 && i<row.length ? row[i] : ""); if((val(col.name)||"").trim()==="") continue;
    const otherCosts={ MRTA:toNumber(val(col.MRTA)),"ค่าประเมิน":toNumber(val(col.appr)),"ค่าจดจำนอง":toNumber(val(col.reg)),"ค่าธรรมเนียม":toNumber(val(col.fee)),"ค่าปรับปิดก่อน":toNumber(val(col.preclose)) };
    list.push({ id:genId(), name:val(col.name), principal:toNumber(val(col.principal)), termYears:toNumber(val(col.termYears)), rate1:toNumber(val(col.rate1)), rate2:toNumber(val(col.rate2)), rate3:toNumber(val(col.rate3)), rateAfter:toNumber(val(col.rateAfter)), monthlyOverride: val(col.monthlyOverride)===""? null: toNumber(val(col.monthlyOverride)), prepayPct:toNumber(val(col.prepayPct)), otherCosts });
  }
  return list;
}

/* ========== Mount ========== */
const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<App />);
