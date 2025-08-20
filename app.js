/* app.js — 20 Aug 2025 patch: Refi term reset 30y, MRTA refund 60% at Y4, Mortgage reg % default, Balance graph uses base, NetInvestment uses cumInterestBase */

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

/* IRR helpers (ใช้ในหน้า Pro Analysis เท่านั้น) */
function irrMonthly(cashflows){
  let lo=-0.99, hi=1.0;
  const npv=(r)=> cashflows.reduce((s,x)=> s + x.cf/Math.pow(1+r, x.t), 0);
  for(let n=0;n<200;n++){
    const mid=(lo+hi)/2, v=npv(mid);
    if(Math.abs(v)<1e-7) return mid;
    const vlo=npv(lo); (vlo*v<=0? hi=mid: lo=mid);
  }
  return (lo+hi)/2;
}
const yearize=(rm)=> (Math.pow(1+rm,12)-1);

/* ========== Core amortization ========== */
function buildSchedule({
  principal,
  termMonths,
  rateSchedule,
  monthlyPaymentOverride = null,
  prepayPct = 0,
  capPerMonth = null,
  installmentMode = "fixPerBlock"
}){
  let balance = principal;
  const rows = [];

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

    let blockLen=0; for(let j=i;j<months.length;j++){ if(months[j].blockIndex!==curBlock) break; blockLen++; }
    let remaining = months.length - i;

    const basePay = monthlyPaymentOverride
      ? monthlyPaymentOverride
      : (r===0 ? balance/remaining : (balance*r*Math.pow(1+r,remaining))/(Math.pow(1+r,remaining)-1));

    for(let k=0;k<blockLen && balance>0;k++){
      const interest = balance * r;
      let principalPay = Math.max(0, basePay - interest);

      // โปะเพิ่มคิดจากค่างวด (basePay) — แล้วตัดด้วย Cap (ห้ามเกิน Cap)
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

/* --- helper: สร้างตารางรีไฟแนนซ์ครั้งแรกและคงอายุสัญญาที่เหลือ --- */
function buildScheduleRefiRemain({
  bank, termMonths, refinanceBehavior, prepayPct = 0, capPerMonth = null
}) {
  const cycle = refinanceBehavior === "every3y" ? 36 : refinanceBehavior === "every5y" ? 60 : 0;
  if (cycle <= 0) {
    // ไม่รีไฟแนนซ์ ใช้ตารางธรรมดา
    return buildSchedule({
      principal: bank.principal,
      termMonths,
      rateSchedule: makeRateSchedule(bank, termMonths, effectiveBehavior(bank.refiPref, refinanceBehavior)),
      monthlyPaymentOverride: bank.monthlyOverride,
      prepayPct,
      capPerMonth
    });
  }

  // ส่วนที่ 1: ก่อนรีไฟแนนซ์
  const eff1 = effectiveBehavior(bank.refiPref, refinanceBehavior);
  const term1 = Math.min(termMonths, cycle);
  const rs1 = makeRateSchedule(bank, term1, eff1);
  const seg1 = buildSchedule({
    principal: bank.principal,
    termMonths: term1,
    rateSchedule: rs1,
    monthlyPaymentOverride: bank.monthlyOverride,
    prepayPct,
    capPerMonth
  });

  if (seg1.endBalance <= 0 || cycle >= termMonths) {
    return seg1; // จบก่อนหรือยังไม่ถึงรอบ
  }

  // ส่วนที่ 2: หลังรีไฟแนนซ์ — ใช้จำนวนเดือนคงเหลือ
  const remainBal = seg1.endBalance;
  const remainTerm = termMonths - cycle;

  // ถ้าเหลือน้อยกว่า 1 ล้าน ไม่รีไฟแนนซ์ต่อ ใช้อัตราหลังครบโปรโมชัน
  const eff2 = remainBal < 1_000_000 ? "stop" : effectiveBehavior(bank.refiPref, refinanceBehavior);
  const rs2 = (eff2 === "stop")
    ? [{ months: remainTerm, rateYear: bank.rateAfter }]
    : makeRateSchedule(bank, remainTerm, eff2);

  const seg2 = buildSchedule({
    principal: remainBal,
    termMonths: remainTerm,
    rateSchedule: rs2,
    monthlyPaymentOverride: bank.monthlyOverride,
    prepayPct,
    capPerMonth
  });

  // รวมช่วง
  const rows = [...seg1.rows, ...seg2.rows.map((r, i) => ({ ...r, index: seg1.rows.length + i + 1 }))];
  const totalInterest = rows.reduce((s, r) => s + r.interest, 0);
  const totalPayment = rows.reduce((s, r) => s + r.payment + (r.extraPrepay || 0), 0);
  const endBalance = rows.length ? rows[rows.length - 1].endBalance : 0;
  return { rows, totalInterest, totalPayment, endBalance };
}

/* ========== คำนวณ "ลงทุนรายเดือน+ทบต้นรายเดือน" ========== */
function computeInvestmentSeriesMonthly(baseRows, investPct, capPerMonth, expectReturnYear){
  // ลงทุนคิดจากค่างวดฐาน (ไม่โปะ) และโดน Cap เช่นเดียวกับโปะ
  const rM = Math.pow(1 + (Number(expectReturnYear||0)/100), 1/12) - 1;
  let investValue = 0;
  let cumInvest   = 0;
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
  { id: genId(), name:"กรุงศรี (ปัจจุบัน)", principal:2623000, termYears:20, rate1:5.37, rate2:5.37, rate3:5.37, rateAfter:5.37, monthlyOverride:null, prepayPct:0.0, refiPref:"default", otherCosts:{ MRTA:0,"ค่าประเมิน":0,"ค่าจดจำนอง":0,"ค่าธรรมเนียม":0,"ค่าปรับปิดก่อน":0 } },
  { id: genId(), name:"ออมสิน (โปร Q3/2568)", principal:2623000, termYears:20, rate1:1.99, rate2:3.805, rate3:3.805, rateAfter:6.37, monthlyOverride:null, prepayPct:0.0, refiPref:"default", otherCosts:{ MRTA:0,"ค่าประเมิน":0,"ค่าจดจำนอง":0,"ค่าธรรมเนียม":1000,"ค่าปรับปิดก่อน":0 } },
];

/* ========== helpers ========== */
function L({ label, children }){ return (<label className="block text-sm"><div className="text-gray-600 mb-1">{label}</div>{children}</label>); }
function Th({ children, className="" }){ return <th className={`text-left ${className}`}>{children}</th>; }
function Td({ children, className="" }){ return <td className={`align-top ${className}`}>{children}</td>; }
function formatTerm(termMonths){ const y=Math.floor(termMonths/12), m=termMonths%12; return `${termMonths} งวด (${y} ปี${m?" "+m+" เดือน":""})`; }

/* ========== refinance schedule helpers ========== */
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
const effectiveBehavior=(bankPref, globalBehavior)=> (bankPref && bankPref!=="default") ? bankPref : globalBehavior;

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
        <L label="รีไฟแนนซ์ (ธนาคารนี้)">
          <select className="ipt" value={bank.refiPref||"default"} onChange={(e)=>handle("refiPref", e.target.value)}>
            <option value="default">ตามค่าหน้าแรก (ค่าเริ่มต้น)</option>
            <option value="none">ไม่รีไฟแนนซ์</option>
            <option value="every3y">รีไฟแนนซ์ทุก 3 ปี</option>
            <option value="every5y">รีไฟแนนซ์ทุก 5 ปี</option>
          </select>
        </L>
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

/* ========== Compare Table (หน้าแรก) ========== */
function CompareTable({ banks, refinanceBehavior, onOpenSchedule, onToggleFocus, showFocus, settings }){
  const rows = useMemo(()=> banks.map((b,idx)=>{
    const planned=Math.round(b.termYears*12);
    const eff = effectiveBehavior(b.refiPref, refinanceBehavior);

    // ตารางงวด (รีไฟแนนซ์ครั้งแรกแล้วคงอายุสัญญาที่เหลือ)
    const schedule = (refinanceBehavior==="every3y"||refinanceBehavior==="every5y")
      ? buildScheduleRefiRemain({ bank:b, termMonths:planned, refinanceBehavior, prepayPct:b.prepayPct||0 })
      : buildSchedule({
          principal:b.principal, termMonths:planned,
          rateSchedule:makeRateSchedule(b, planned, eff),
          monthlyPaymentOverride:b.monthlyOverride, prepayPct:b.prepayPct||0, installmentMode:"fixPerBlock"
        });

    const payoffMonths=schedule.rows.length, first36=schedule.rows.slice(0,36), first60=schedule.rows.slice(0,60);
    const int3y=first36.reduce((s,r)=>s+r.interest,0), prepay3y=first36.reduce((s,r)=>s+(r.extraPrepay||0),0);
    const int5y=first60.reduce((s,r)=>s+r.interest,0), prepay5y=first60.reduce((s,r)=>s+(r.extraPrepay||0),0);

    // ค่าจดจำนอง: ถ้าไม่กรอก ให้คำนวณจาก % เริ่มต้น
    const enteredReg = Number((b.otherCosts||{})["ค่าจดจำนอง"]||0);
    const autoReg    = Math.max(enteredReg, Number(settings.regFeePct||1)/100 * Number(b.principal||0));

    // MRTA รวม/เวนคืน
    const mrta = Number((b.otherCosts||{}).MRTA||0);
    const baseOther = sumOtherCosts(b.otherCosts) - mrta; // ตัด MRTA ออกก่อน
    const other3y = baseOther + (settings.includeMrtaInLoan ? mrta : 0) - 0 /* ยังไม่เวนคืนใน 3y */;
    const refund5y = (refinanceBehavior!=="none") ? (Number(settings.mrtaRefundPct||60)/100 * mrta) : 0;
    const other5y = baseOther + (settings.includeMrtaInLoan ? mrta : 0) - refund5y;

    // แทนค่าจดจำนองออโต้ (ถ้าไม่กรอก)
    const other3yFinal = other3y - enteredReg + autoReg;
    const other5yFinal = other5y - enteredReg + autoReg;

    const total3y=int3y+other3yFinal;
    const total5y=int5y+other5yFinal;

    const stepPays=[]; let lastPay=null;
    for(const r of schedule.rows){
      const pay=Math.round(r.payment);
      if(lastPay===null || Math.abs(pay-lastPay)>1){ stepPays.push(pay); lastPay=pay; }
      if(stepPays.length>=4) break;
    }
    const stepText = stepPays.map(v=>fmtMoney(v)).join(" → ");

    return {
      id:b.id, index:idx, name:b.name,
      stepText,
      prepay3y, interest3y:int3y, total3y,
      prepay5y, interest5y:int5y, total5y,
      after3yRate:b.rateAfter, payoffMonths,
      totalInterestAll:schedule.totalInterest, otherCosts3y:other3yFinal, otherCosts5y:other5yFinal
    };
  }), [banks, refinanceBehavior, settings]);

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
                <Td className="text-right mono">{fmtMoney(r.otherCosts3y)}</Td>
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

function ScheduleView({ bank, refinanceBehavior, settings }){
  const planned=Math.round(bank.termYears*12);
  const eff = effectiveBehavior(bank.refiPref, refinanceBehavior);
  const [startYM, setStartYM]=useState(()=>{ const d=new Date(); const y=d.getFullYear(); const m=String(d.getMonth()+1).padStart(2,"0"); return `${y}-${m}`; });

  const schedule=useMemo(()=>{
    return (refinanceBehavior==="every3y"||refinanceBehavior==="every5y")
      ? buildScheduleRefiRemain({ bank, termMonths:planned, refinanceBehavior, prepayPct:bank.prepayPct||0 })
      : buildSchedule({
          principal:bank.principal, termMonths:planned,
          rateSchedule:makeRateSchedule(bank, planned, eff),
          monthlyPaymentOverride:bank.monthlyOverride, prepayPct:bank.prepayPct||0, installmentMode:"fixPerBlock"
        });
  }, [bank, planned, eff, refinanceBehavior]);

  const totalI=schedule.totalInterest, totalP=schedule.rows.reduce((s,r)=>s+r.principalTotal,0);

  const exportCSV=()=>{ 
    const header=["เดือน","งวด","อัตราดอกเบี้ย(%)","ค่างวด","โปะเพิ่ม","เงินต้น","เงินต้นรวม","ดอกเบี้ย","คงเหลือ"].join(",");
    const body=schedule.rows.map((r,idx)=>[
      thaiMonthLabel(addMonthsYM(startYM, idx)), r.index, fmtRate(r.rate),
      r.payment.toFixed(2), r.extraPrepay.toFixed(2), r.principal.toFixed(2),
      r.principalTotal.toFixed(2), r.interest.toFixed(2), r.endBalance.toFixed(2)
    ].join(",")).join("\r\n");
    const csv="\uFEFF"+header+"\r\n"+body; 
    const blob=new Blob([csv],{type:"text/csv;charset=utf-8;"}); 
    const url=URL.createObjectURL(blob); 
    const a=document.createElement("a"); a.href=url; a.download=`${bank.name}-schedule.csv`; a.click(); URL.revokeObjectURL(url); 
  };

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

/* ========== Dropdown Multi (reusable) ========== */
function DropdownMulti({ label, options, valueIds, onToggle, max=3 }){
  const [open, setOpen]=useState(false);
  const anchorRef=useRef(null);
  const menuRef=useRef(null);
  const [pos, setPos]=useState({left:0, top:0, width:280});

  const selected=options.filter(o=>valueIds.includes(o.id));
  const title = selected.length ? `${label}: ${selected.map(s=>s.name).join(", ").slice(0,60)}${selected.map(s=>s.name).join(", ").length>60?"…":""}` : label;

  const recalc = ()=> {
    if(!anchorRef.current) return;
    const r=anchorRef.current.getBoundingClientRect();
    setPos({ left: r.left + window.scrollX, top: r.bottom + window.scrollY + 6, width: Math.max(280, r.width) });
  };

  useEffect(()=>{ if(!open) return;
    recalc();
    const onDown=(e)=>{ 
      if(anchorRef.current?.contains(e.target)) return;
      if(menuRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onScroll=()=>recalc();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("resize", onScroll);
    window.addEventListener("scroll", onScroll, true);
    return ()=>{ 
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  return (
    <div className="dropdown">
      <button ref={anchorRef} className="btn-secondary ipt-sm" onClick={()=>setOpen(v=>!v)} title={title} aria-haspopup="listbox" aria-expanded={open}>
        {selected.length? `${label} (${selected.length}/${max})` : label}
      </button>

      {open && ReactDOM.createPortal(
        <div ref={menuRef} className="dropdown-menu"
             style={{ position:"fixed", left:pos.left+"px", top:pos.top+"px", minWidth:pos.width+"px", zIndex:9999 }}>
          {options.map(opt=>{
            const checked=valueIds.includes(opt.id); const disabled=!checked && valueIds.length>=max;
            return (
              <label key={opt.id} className="item text-sm">
                <input type="checkbox" checked={checked} disabled={disabled} onChange={()=>onToggle(opt.id)} />
                <span className={disabled?"text-gray-400":""}>{opt.name}</span>
              </label>
            );
          })}
          <div className="dropdown-footer">เลือกได้สูงสุด {max} รายการ</div>
        </div>
      , document.body)}
    </div>
  );
}

/* ========== Investment View ========== */
const METRIC_OPTIONS = [
  { id:"cumWith",      name:"ดอกเบี้ยรวมสะสม (มีโปะ)" },
  { id:"cumBase",      name:"ดอกเบี้ยรวมสะสม (ไม่โปะ)" },
  { id:"balanceWith",  name:"หนี้คงเหลือ (มีโปะ)" },
  { id:"balanceBase",  name:"หนี้คงเหลือ (ไม่โปะ)" },
  { id:"cumInvest",    name:"เงินต้นลงทุนสะสม" },
  { id:"investValue",  name:"มูลค่าพอร์ตลงทุน" },
  { id:"profit",       name:"กำไรลงทุนสะสม" },
  { id:"netInv",       name:"Net Investment (พอร์ต–ดอกสะสม)" },
];

function InvestmentView({ banks, refinanceBehavior, onChangeRefiBehavior }){
  const [overridePrepayPct, setOverridePrepayPct] = useState("");
  const [monthlyCap, setMonthlyCap] = useState("");
  const [expectReturn, setExpectReturn] = useState("7");
  const [graphMode, setGraphMode] = useState("saved"); // 'saved' | 'total' | 'balance'
  const [showChart, setShowChart] = useState(false);
  const [selectedIds, setSelectedIds] = useState(()=> banks.slice(0,2).map(b=>b.id));
  const [visibleMetrics, setVisibleMetrics] = useState(METRIC_OPTIONS.map(m=>m.id)); // เปิดหมดเป็นค่าเริ่มต้น
  useEffect(()=>{ if(selectedIds.length===0 && banks[0]) setSelectedIds([banks[0].id]); }, [banks]);
  const toggleSelect=(id)=> setSelectedIds(prev=>{ const has=prev.includes(id); let next = has? prev.filter(x=>x!==id) : [...prev, id]; if(next.length>3) next=next.slice(1); return next; });
  const toggleMetric=(id)=> setVisibleMetrics(prev=> prev.includes(id)? prev.filter(x=>x!==id): [...prev, id]);

  const canvasRef=useRef(null);

  /* ---- calc yearly ---- */
  const calcData = useMemo(()=> banks.map((b)=>{
    const termMonths=Math.round(b.termYears*12);
    const pctUse = (overridePrepayPct===""? (b.prepayPct||0) : Number(overridePrepayPct||0));
    const cap = Number(monthlyCap||0);
    const eff = effectiveBehavior(b.refiPref, refinanceBehavior);

    const schedWith = buildSchedule({
      principal:b.principal, termMonths,
      rateSchedule:makeRateSchedule(b, termMonths, eff),
      monthlyPaymentOverride:b.monthlyOverride, prepayPct:pctUse, capPerMonth: cap>0? cap: null, installmentMode:"fixPerBlock"
    });

    const schedBase = buildSchedule({
      principal:b.principal, termMonths,
      rateSchedule:makeRateSchedule(b, termMonths, eff),
      monthlyPaymentOverride:b.monthlyOverride, prepayPct:0, capPerMonth:null, installmentMode:"fixPerBlock"
    });

    const investSeries = computeInvestmentSeriesMonthly(schedBase.rows, pctUse, cap>0? cap: null, expectReturn);

    const years=Math.max(Math.ceil(schedWith.rows.length/12), Math.ceil(schedBase.rows.length/12));
    const perYear=[]; let cumInterestWith=0, cumInterestBase=0;

    for(let y=0;y<years;y++){
      const sw=schedWith.rows.slice(y*12,y*12+12), sb=schedBase.rows.slice(y*12,y*12+12);
      const interestWith=sw.reduce((s,row)=>s+row.interest,0), interestBase=sb.reduce((s,row)=>s+row.interest,0);
      cumInterestWith+=interestWith; cumInterestBase+=interestBase;

      const invY = investSeries[y] || { investValue:0, investProfit:0, cumInvest:0, capHitInvest:false };

      // หนี้คงเหลือปลายปี
      const endBalWith = sw.length>0 ? sw[sw.length-1].endBalance : (schedWith.rows.length>0 ? schedWith.rows[schedWith.rows.length-1].endBalance : 0);
      const endBalBase = sb.length>0 ? sb[sb.length-1].endBalance : (schedBase.rows.length>0 ? schedBase.rows[schedBase.rows.length-1].endBalance : 0);

      // ✅ Net Investment = พอร์ต – ดอกสะสม (ไม่โปะ)
      const netInvestment = invY.investValue - cumInterestBase;

      perYear.push({
        yearIndex: y+1,
        cumInterestWith,
        cumInterestBase,
        balanceWith: endBalWith,
        balanceBase: endBalBase,
        cumInvest: invY.cumInvest,
        investValue: invY.investValue,
        investProfit: invY.investProfit,
        netInvestment,
        savedInterestYear: Math.max(0, interestBase - interestWith),
        capHitInvest: invY.capHitInvest
      });
    }

    let cumSaved=0;
    const seriesSaved=[], seriesProfit=[], seriesTotWith=[], seriesTotBase=[], seriesVal=[], seriesRemWith=[], seriesRemBase=[];
    perYear.forEach(y=>{
      cumSaved += y.savedInterestYear;
      seriesSaved.push(cumSaved);
      seriesProfit.push(y.investProfit);
      seriesTotWith.push(y.cumInterestWith);
      seriesTotBase.push(y.cumInterestBase);
      seriesVal.push(y.investValue);
      seriesRemWith.push(y.balanceWith);
      seriesRemBase.push(y.balanceBase);
    });

    return {
      id:b.id, name:b.name, years:perYear,
      chartSeries:{
        saved:seriesSaved, profit:seriesProfit, totWith:seriesTotWith, totBase:seriesTotBase, val:seriesVal,
        remWith:seriesRemWith, remBase:seriesRemBase
      }
    };
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
    }else if(graphMode==="total"){
      selected.forEach((d,idx)=>{
        series.push(d.chartSeries.totWith); labels.push(`${d.name} — ดอกเบี้ยรวมสะสม`);    colors.push(colorPairs[idx%colorPairs.length][0]);
        series.push(d.chartSeries.val);     labels.push(`${d.name} — มูลค่าพอร์ตลงทุน`);    colors.push(colorPairs[idx%colorPairs.length][1]);
      });
    }else if(graphMode==="balance"){ 
      // ✅ ใช้หนี้คงเหลือ (ไม่โปะ) ↔ พอร์ตลงทุน
      selected.forEach((d,idx)=>{
        series.push(d.chartSeries.remBase); labels.push(`${d.name} — หนี้คงเหลือ (ไม่โปะ)`); colors.push(colorPairs[idx%colorPairs.length][0]);
        series.push(d.chartSeries.val);     labels.push(`${d.name} — มูลค่าพอร์ตลงทุน`);    colors.push(colorPairs[idx%colorPairs.length][1]);
      });
    }

    function draw(hoverI=null){
      const W=canvas.clientWidth*dpi, H=canvas.clientHeight*dpi; canvas.width=W; canvas.height=H;
      const allY=series.flat(); const maxY=Math.max(1, ...allY);
      const pad=40*dpi, plotW=W-pad*2, plotH=H-pad*2;
      ctx.clearRect(0,0,W,H); ctx.fillStyle="#fff"; ctx.fillRect(0,0,W,H);

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
        ctx.strokeStyle=colors[si]; ctx.lineWidth=2*dpi;
        ctx.stroke();
      });

      const colW=420*dpi, startX=W-pad-colW, startY=pad;
      labels.forEach((lb,i)=>{ const y=startY + i*16*dpi; ctx.fillStyle=colors[i]; ctx.fillRect(startX,y,10*dpi,10*dpi); ctx.fillStyle="#111827"; ctx.fillText(lb, startX+14*dpi, y+10*dpi); });

      if(hoverI!==null){
        const xh=xOf(hoverI, series[0].length);
        ctx.strokeStyle="#9ca3af"; ctx.setLineDash([4*dpi,4*dpi]);
        ctx.beginPath(); ctx.moveTo(xh,pad); ctx.lineTo(xh,H-pad); ctx.stroke(); ctx.setLineDash([]);

        const vals=series.map(arr=>arr[hoverI]??0);
        vals.forEach((v,si)=>{ ctx.beginPath(); ctx.arc(xh, yOf(v), 3*dpi, 0, Math.PI*2); ctx.fillStyle=colors[si]; ctx.fill(); });

        const tip=[`ปี ${hoverI+1}`, ...labels.map((lb,i)=>`${lb}: ${fmtMoney(vals[i])} บ.`)];
        const boxW=460*dpi, boxH=(tip.length*16+12)*dpi;
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
    const header=["ธนาคาร","ปี","SavedInterestCum","InvestProfitCum","InvestPrincipalCum","InvestValueEnd","NetInvestment","TotalInterestWith","TotalInterestBase","BalanceWith","BalanceBase","CapHit"].join(",");
    const body=calcData.map(d=> d.years.map((y,i)=>[
      d.name, y.yearIndex,
      (d.chartSeries.saved[i]||0).toFixed(2),
      (d.chartSeries.profit[i]||0).toFixed(2),
      y.cumInvest.toFixed(2),
      y.investValue.toFixed(2),
      y.netInvestment.toFixed(2),
      (d.chartSeries.totWith[i]||0).toFixed(2),
      (d.chartSeries.totBase[i]||0).toFixed(2),
      (d.chartSeries.remWith[i]||0).toFixed(2),
      (d.chartSeries.remBase[i]||0).toFixed(2),
      y.capHitInvest?1:0
    ].join(",")).join("\r\n")).join("\r\n");
    const csv="\uFEFF"+header+"\r\n"+body; 
    const blob=new Blob([csv],{type:"text/csv;charset=utf-8;"}); 
    const url=URL.createObjectURL(blob); 
    const a=document.createElement("a"); a.href=url; a.download="investment_compare.csv"; a.click(); URL.revokeObjectURL(url); 
  };

  // metric visibility helpers
  const show = (id)=> visibleMetrics.includes(id);

  return (
    <div className="space-y-3 invest-wrap">
      <div className="invest-head">Investment (ต่อปี)</div>

      {/* controls: one line, scrollable horizontally */}
      <div className="controls-card" title="เลื่อนแนวนอนได้ถ้าพื้นที่ไม่พอ">
        <div className="controls-scroll">
          <div className="group">
            <label className="text-xs text-gray-600">Refinance:</label>
            <select
              className="ipt ipt-sm"
              value={refinanceBehavior}
              onChange={(e)=>onChangeRefiBehavior(e.target.value)}
              aria-label="Refinance behavior"
            >
              <option value="none">ไม่รีไฟแนนซ์</option>
              <option value="every3y">รีไฟแนนซ์ทุก 3 ปี</option>
              <option value="every5y">รีไฟแนนซ์ทุก 5 ปี</option>
            </select>
          </div>

          <DropdownMulti
            label="เลือกธนาคาร (กราฟ)"
            options={banks}
            valueIds={selectedIds}
            onToggle={toggleSelect}
            max={3}
          />

          <DropdownMulti
            label="เลือกคอลัมน์"
            options={METRIC_OPTIONS}
            valueIds={visibleMetrics}
            onToggle={toggleMetric}
            max={METRIC_OPTIONS.length}
          />

          <div className="group">
            <label className="text-xs text-gray-600">โหมดกราฟ:</label>
            <select
              className="ipt ipt-sm"
              value={graphMode}
              onChange={e=>setGraphMode(e.target.value)}
              aria-label="Graph mode"
            >
              <option value="saved">ประหยัดดอกสะสม ↔ กำไรลงทุน</option>
              <option value="total">ดอกเบี้ยรวมสะสม ↔ มูลค่าพอร์ตลงทุน</option>
              <option value="balance">หนี้คงเหลือ ↔ มูลค่าพอร์ตลงทุน</option>
            </select>
          </div>

          <div className="group">
            <label className="text-xs text-gray-600">ลงทุนเพิ่ม (%)</label>
            <input
              className="ipt ipt-num ipt-sm mono"
              style={{width:90}}
              placeholder="เช่น 5"
              defaultValue={overridePrepayPct}
              onBlur={(e)=> setOverridePrepayPct(e.target.value.trim())}
            />
          </div>

          <div className="group">
            <label className="text-xs text-gray-600">เพดาน/เดือน (บาท)</label>
            <input
              className="ipt ipt-num ipt-sm mono"
              style={{width:140}}
              placeholder="เช่น 16000"
              defaultValue={monthlyCap}
              onBlur={(e)=> setMonthlyCap(e.target.value.trim())}
            />
          </div>

          <div className="group">
            <label className="text-xs text-gray-600">คาดหวังผลตอบแทน/ปี (%)</label>
            <input
              className="ipt ipt-num ipt-sm mono"
              style={{width:90}}
              placeholder="5–8"
              defaultValue={expectReturn}
              onBlur={(e)=> setExpectReturn(e.target.value.trim())}
            />
          </div>

          <button className="btn-secondary ipt-sm" onClick={exportCSV} title="ส่งออกข้อมูลการลงทุน" aria-label="Export investment">Export</button>
          <button className="btn ipt-sm" onClick={()=>setShowChart(true)} title="ดูกราฟเปรียบเทียบ" aria-label="Open chart">ดูกราฟ</button>
        </div>
      </div>

      {/* ตาราง */}
      <div className="table-wrap sticky-first" style={{ maxHeight:"75vh" }}>
        <table className="text-sm">
          <thead>
            <tr>
              <Th className="first-col">ธนาคาร / รายการ</Th>
              {Array.from({length:maxYears},(_,i)=>(<Th key={i} className="text-right year-col">ปีที่ {i+1}</Th>))}
            </tr>
          </thead>
          <tbody>
            {calcData.map((d,di)=>(
              <React.Fragment key={d.id}>
                {di>0 && <tr className="bank-divider"><Td colSpan={maxYears+1}>{d.name}</Td></tr>}
                {di===0 && <tr className="bank-divider"><Td colSpan={maxYears+1}>{d.name}</Td></tr>}

                {visibleMetrics.includes("cumWith") && (
                  <tr>
                    <Td className="sub-label first-col">ดอกเบี้ยรวมสะสม (กรณีมีโปะ)</Td>
                    {Array.from({length:maxYears},(_,i)=>(<Td key={`ci-${di}-${i}`} className="text-right mono">{fmtMoney(d.years[i]?.cumInterestWith||0)}</Td>))}
                  </tr>
                )}

                {visibleMetrics.includes("cumBase") && (
                  <tr>
                    <Td className="sub-label first-col">ดอกเบี้ยรวมสะสม (ไม่โปะ)</Td>
                    {Array.from({length:maxYears},(_,i)=>(<Td key={`cib-${di}-${i}`} className="text-right mono">{fmtMoney(d.years[i]?.cumInterestBase||0)}</Td>))}
                  </tr>
                )}

                {visibleMetrics.includes("balanceWith") && (
                  <tr>
                    <Td className="sub-label first-col">หนี้คงเหลือ (กรณีมีโปะ)</Td>
                    {Array.from({length:maxYears},(_,i)=>(<Td key={`bw-${di}-${i}`} className="text-right mono">{fmtMoney(d.years[i]?.balanceWith||0)}</Td>))}
                  </tr>
                )}

                {visibleMetrics.includes("balanceBase") && (
                  <tr>
                    <Td className="sub-label first-col">หนี้คงเหลือ (กรณีไม่โปะ)</Td>
                    {Array.from({length:maxYears},(_,i)=>(<Td key={`bb-${di}-${i}`} className="text-right mono">{fmtMoney(d.years[i]?.balanceBase||0)}</Td>))}
                  </tr>
                )}

                {visibleMetrics.includes("cumInvest") && (
                  <tr>
                    <Td className="sub-label first-col">เงินต้นลงทุนสะสม (ยอดลงทุนรายเดือน)</Td>
                    {Array.from({length:maxYears},(_,i)=>(<Td key={`cumInv-${di}-${i}`} className={`text-right mono ${d.years[i]?.capHitInvest?"cap-alert":""}`}>{fmtMoney(d.years[i]?.cumInvest||0)}</Td>))}
                  </tr>
                )}

                {visibleMetrics.includes("investValue") && (
                  <tr>
                    <Td className="sub-label first-col">มูลค่าพอร์ตลงทุน (สิ้นปี)</Td>
                    {Array.from({length:maxYears},(_,i)=>(<Td key={`val-${di}-${i}`} className="text-right mono">{fmtMoney(d.years[i]?.investValue||0)}</Td>))}
                  </tr>
                )}

                {visibleMetrics.includes("profit") && (
                  <tr>
                    <Td className="sub-label first-col">กำไรลงทุนสะสม</Td>
                    {Array.from({length:maxYears},(_,i)=>(<Td key={`profit-${di}-${i}`} className="text-right mono">{fmtMoney(d.years[i]?.investProfit||0)}</Td>))}
                  </tr>
                )}

                {visibleMetrics.includes("netInv") && (
                  <tr>
                    <Td className="sub-label first-col">Net Investment (พอร์ต – ดอกสะสม)</Td>
                    {Array.from({length:maxYears},(_,i)=>(<Td key={`net-${di}-${i}`} className="text-right mono">{fmtMoney(d.years[i]?.netInvestment||0)}</Td>))}
                  </tr>
                )}

                <tr><Td colSpan={maxYears+1} style={{height:6}}></Td></tr>
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <div className="text-xs text-gray-500">
        * ไฮไลท์เหลือง = ปีนั้นมีเดือนที่ “ค่างวด + เงินลงทุนตามที่ตั้ง” เกินเพดาน/เดือน •
        โหมดกราฟ “ประหยัดดอกสะสม” แสดง Base=0 ตามนิยาม •
        โหมด “ดอกเบี้ยรวมสะสม ↔ มูลค่าพอร์ตลงทุน” และ “หนี้คงเหลือ ↔ มูลค่าพอร์ตลงทุน” แสดงสองเส้นต่อธนาคาร
      </div>

      {showChart && (
        <div className="chart-modal" onClick={()=>setShowChart(false)}>
          <div className="chart-box" onClick={(e)=>e.stopPropagation()}>
            <div className="chart-head">
              <div className="font-semibold">
                กราฟเทียบหลายธนาคาร (แกน Y = บาท, แกน X = ปี) — โหมด: {
                  graphMode==="saved"
                    ? "ประหยัดดอกสะสม ↔ กำไรลงทุน"
                    : graphMode==="total"
                      ? "ดอกเบี้ยรวมสะสม ↔ มูลค่าพอร์ตลงทุน"
                      : "หนี้คงเหลือ ↔ มูลค่าพอร์ตลงทุน"
                }
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

/* ========== Pro Analysis ========== */
function CompareTablePro({ banks, refinanceBehavior, settings }){
  const rows = useMemo(()=>{
    const planned0=Math.round((banks[0]?.termYears||0)*12) || 0;
    const eff0 = banks[0]? effectiveBehavior(banks[0].refiPref, refinanceBehavior): "none";
    const baseSched = banks[0] ? buildSchedule({
      principal:banks[0].principal, termMonths:planned0,
      rateSchedule:makeRateSchedule(banks[0], planned0, eff0),
      monthlyPaymentOverride:banks[0].monthlyOverride, prepayPct:banks[0].prepayPct||0, installmentMode:"fixPerBlock"
    }) : {rows:[]};

    return banks.map((b,idx)=>{
      const planned=Math.round(b.termYears*12);
      const eff = effectiveBehavior(b.refiPref, refinanceBehavior);
      const sched=buildSchedule({
        principal:b.principal, termMonths:planned,
        rateSchedule:makeRateSchedule(b, planned, eff),
        monthlyPaymentOverride:b.monthlyOverride, prepayPct:b.prepayPct||0, installmentMode:"fixPerBlock"
      });

      const cycleMonths = eff==="every3y" ? 36 : eff==="every5y" ? 60 : 0;
      let refiCostsByMonth = new Map();
      if(cycleMonths>0){
        for(let m=cycleMonths; m<=sched.rows.length; m+=cycleMonths){
          let fee = Number(settings.refiFeePerCycle||0);
          if(settings.lockinMonths && m <= Number(settings.lockinMonths)){
            const penaltyPct = Number(settings.preclosePenaltyPct||0)/100;
            const remain = sched.rows[m-1]?.endBalance ?? 0;
            fee += penaltyPct*remain;
          }
          refiCostsByMonth.set(m, (refiCostsByMonth.get(m)||0)+fee);
        }
      }

      const otherBase = sumOtherCosts(b.otherCosts);

      // Pro table ยังคงตรรกะเดิม (ไม่รวม MRTA refund/auto reg %) เพื่อใช้เป็น baseline professional; ถ้าต้องการให้ใส่เหมือนหน้าแรก บอกได้ครับ
      const first36=sched.rows.slice(0,36), first60=sched.rows.slice(0,60);
      const int3y=first36.reduce((s,r)=>s+r.interest,0);
      const int5y=first60.reduce((s,r)=>s+r.interest,0);

      const total3y = int3y + otherBase;
      const total5y = int5y + otherBase;

      let breakEvenMonth = null;
      if(idx>0 && baseSched.rows.length){
        let cumSaved=0, cumCost=otherBase;
        for(let m=1;m<=Math.min(baseSched.rows.length, sched.rows.length);m++){
          const saved = Math.max(0,(baseSched.rows[m-1]?.interest||0)-(sched.rows[m-1]?.interest||0));
          cumSaved += saved;
          if(refiCostsByMonth.has(m)) cumCost += refiCostsByMonth.get(m);
          if(cumSaved + 1e-6 >= cumCost){ breakEvenMonth = m; break; }
        }
      }

      const flows=[];
      flows.push({t:0, cf:+b.principal - otherBase});
      sched.rows.forEach((r,i)=>{ 
        let out = r.payment + (r.extraPrepay||0);
        const add = refiCostsByMonth.get(i+1); if(add) out += add;
        flows.push({t:i+1, cf:-out});
      });
      const eir = yearize(irrMonthly(flows));

      const stepPays=[]; let lastPay=null;
      for(const r of sched.rows){
        const pay=Math.round(r.payment); 
        if(lastPay===null || Math.abs(pay-lastPay)>1){ stepPays.push(pay); lastPay=pay; }
        if(stepPays.length>=4) break;
      }
      const stepText=stepPays.map(v=>fmtMoney(v)).join(" → ");

      return {
        id:b.id, index:idx, name:b.name, stepText,
        otherCosts:otherBase,
        interest3y:int3y, interest5y:int5y,
        total3y, total5y, eirYear: eir, breakEvenMonth,
        payoffMonths:sched.rows.length, totalInterestAll:sched.totalInterest
      };
    });
  }, [banks, refinanceBehavior, settings]);

  const best3 = rows.length ? Math.min(...rows.map(r=>r.total3y)) : null;
  const worst3 = rows.length ? Math.max(...rows.map(r=>r.total3y)) : null;
  const best5 = rows.length ? Math.min(...rows.map(r=>r.total5y)) : null;
  const worst5 = rows.length ? Math.max(...rows.map(r=>r.total5y)) : null;

  return (
    <div className="table-wrap">
      <table className="min-w-full text-sm">
        <thead>
          <tr>
            <Th>ธนาคาร</Th>
            <Th className="text-right">ค่างวด/เดือน (ตามบล็อกดอก)</Th>
            <Th className="text-center">Break-even</Th>
            <Th className="text-right">EIR (ต่อปี)</Th>
            <Th className="text-right">ดอกเบี้ยรวม 3 ปี</Th>
            <Th className="text-right">ค่าใช้จ่ายอื่น ๆ</Th>
            <Th className="text-right">รวม 3 ปี</Th>
            <Th className="text-right">ดอกเบี้ยรวม 5 ปี</Th>
            <Th className="text-right">รวม 5 ปี</Th>
            <Th className="text-right">จำนวนงวดที่เหลือ</Th>
            <Th className="text-right">ดอกเบี้ยรวมทั้งสัญญา</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r=>{
            const cls3=r.total3y===best3?"cell-min":r.total3y===worst3?"cell-max":"";
            const cls5=r.total5y===best5?"cell-min":r.total5y===worst5?"cell-max":"";
            return (
              <tr key={r.id}>
                <Td>{r.name}</Td>
                <Td className="text-right mono">{r.stepText||"—"}</Td>
                <Td className="text-center mono">{r.index===0? "—" : (r.breakEvenMonth? `เดือนที่ ${r.breakEvenMonth}`:"ยังไม่คุ้ม")}</Td>
                <Td className="text-right mono">{isFinite(r.eirYear)? ((r.eirYear*100).toFixed(2)+"%") : "—"}</Td>
                <Td className="text-right mono">{fmtMoney(r.interest3y)}</Td>
                <Td className="text-right mono">{fmtMoney(r.otherCosts)}</Td>
                <Td className="text-right mono"><span className={cls3}>{fmtMoney(r.total3y)}</span></Td>
                <Td className="text-right mono">{fmtMoney(r.interest5y)}</Td>
                <Td className="text-right mono"><span className={cls5}>{fmtMoney(r.total5y)}</span></Td>
                <Td className="text-right mono">{formatTerm(r.payoffMonths)}</Td>
                <Td className="text-right mono">{fmtMoney(r.totalInterestAll)}</Td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function DSRBadge({ pct }){
  const cls = pct<=35? "ok": pct<=50? "warn": "bad";
  const label = `${pct.toFixed(1)}%`;
  return <span className={`dsr ${cls}`}>DSR: {label}</span>;
}

function ProAnalysis({ banks, refinanceBehavior, onBack }){
  const [settings, setSettings]=useState({
    refiFeePerCycle:0, lockinMonths:0, preclosePenaltyPct:0,
    applyMortgageDeduction:false, taxRate:10,
    incomeNet:0, otherDebt:0
  });

  const dsrInfo = useMemo(()=>{
    if(!banks[0]) return {pct:0};
    const planned=Math.round(banks[0].termYears*12);
    const eff = effectiveBehavior(banks[0].refiPref, refinanceBehavior);
    const sched=buildSchedule({
      principal:banks[0].principal, termMonths:planned,
      rateSchedule:makeRateSchedule(banks[0], planned, eff),
      monthlyPaymentOverride:banks[0].monthlyOverride, prepayPct:banks[0].prepayPct||0
    });
    const maxPay = Math.max(...sched.rows.map(r=>r.payment));
    const totalDebt = maxPay + Number(settings.otherDebt||0);
    const income = Math.max(1, Number(settings.incomeNet||0));
    const pct = totalDebt/income*100;
    return {pct};
  }, [banks, refinanceBehavior, settings.incomeNet, settings.otherDebt]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <button className="btn-secondary ipt-sm" onClick={onBack} aria-label="Back">← Back</button>
        <div className="text-lg font-semibold">Pro Analysis — พร้อมยื่นกู้จริง</div>
      </div>

      <div className="flex items-center gap-3">
        <DSRBadge pct={dsrInfo.pct}/>
        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-600">Net income / mo.</label>
          <MoneyInput value={settings.incomeNet} onChange={(v)=>setSettings({...settings, incomeNet:v})}/>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-600">Other debts / mo.</label>
          <MoneyInput value={settings.otherDebt} onChange={(v)=>setSettings({...settings, otherDebt:v})}/>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-600">Refinance:</label>
          <select className="ipt ipt-sm" value={refinanceBehavior} onChange={()=>{}} disabled aria-label="Refinance behavior">
            <option>ตั้งค่าที่หน้าแรก</option>
          </select>
        </div>
      </div>

      <div className="grid md:grid-cols-3 grid-cols-1 gap-3">
        <div className="card p-3 border border-gray-200 rounded-xl bg-white">
          <div className="font-semibold mb-2">Refi Costs (per cycle)</div>
          <L label="refiFeePerCycle (บาท)"><MoneyInput value={settings.refiFeePerCycle} onChange={(v)=>setSettings({...settings, refiFeePerCycle:v})}/></L>
          <L label="lockinMonths (เดือน)"><MoneyInput value={settings.lockinMonths} onChange={(v)=>setSettings({...settings, lockinMonths:v})}/></L>
          <L label="preclosePenaltyPct (% of balance)"><RateInput value={settings.preclosePenaltyPct} onChange={(v)=>setSettings({...settings, preclosePenaltyPct:v})}/></L>
        </div>
        <div className="card p-3 border border-gray-200 rounded-xl bg-white">
          <div className="font-semibold mb-2">Tax & Deduction</div>
          <div className="flex items-center gap-2 mb-2">
            <input id="ded" type="checkbox" checked={!!settings.applyMortgageDeduction} onChange={(e)=>setSettings({...settings, applyMortgageDeduction:e.target.checked})}/>
            <label htmlFor="ded">Mortgage deduction ≤ 100,000/yr</label>
          </div>
          <L label="Marginal tax rate (%)"><RateInput value={settings.taxRate} onChange={(v)=>setSettings({...settings, taxRate:v})}/></L>
        </div>
      </div>

      <CompareTablePro banks={banks} refinanceBehavior={refinanceBehavior} settings={settings}/>
      <div className="text-xs text-gray-500">* Break-even = เดือนที่ประหยัดดอกสะสม ≥ ต้นทุนรีไฟฯรวม • EIR คิดจากกระแสเงินสดจริง (T0 และรายเดือน)</div>
    </div>
  );
}

/* ========== App (routing) ========== */
function useLocalState(key, initial){
  const [state, setState]=useState(()=>{ try{ const s=localStorage.getItem(key); return s? JSON.parse(s): initial; }catch{ return initial; } });
  useEffect(()=>{ localStorage.setItem(key, JSON.stringify(state)); },[key, state]);
  return [state, setState];
}

const IconDownload=()=>(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M12 3v12m0 0l-4-4m4 4l4-4"/><path d="M3 21h18"/></svg>);
const IconUpload=()=>(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M12 21V9m0 0l4 4m-4-4l-4 4"/><path d="M3 3h18"/></svg>);
const IconPlus=()=>(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>);

function App(){
  const [banks, setBanks]=useLocalState("mortgage-banks", DEFAULT_BANKS);
  const [route, setRoute]=useState(window.location.hash||"#/");
  const [focusCompare, setFocusCompare]=useState(false);
  const [refinanceBehavior, setRefinanceBehavior]=useState("none");

  // 🆕 Global settings: reg %, MRTA options
  const [settings, setSettings] = useLocalState("mortgage-settings", {
    regFeePct: 1.00,           // ค่าจดจำนอง % เริ่มต้น
    includeMrtaInLoan: false,  // กู้รวม MRTA ไหม
    mrtaRefundPct: 60          // เวนคืน MRTA ณ ปีที่ 4
  });

  const fileRef=React.useRef(null);

  useEffect(()=>{ setBanks(prev=>{ let changed=false; const fixed=(prev||[]).map(b=>(!b.id? (changed=true, {...b, id:genId()}): b)); return changed? fixed: prev; }); },[]);
  useEffect(()=>{ const onHash=()=> setRoute(window.location.hash||"#/"); window.addEventListener("hashchange", onHash); return ()=> window.removeEventListener("hashchange", onHash); },[]);

  const goHome=()=>{ window.location.hash="#/"; };
  const openSchedule=(i)=>{ window.location.hash=`#/schedule/${i}`; };
  const openInvest=()=>{ window.location.hash="#/invest"; };
  const openAnalysis=()=>{ window.location.hash="#/analysis"; };

  const addBank=()=> setBanks([...banks, { id:genId(), name:`ตัวเลือกใหม่ #${banks.length+1}`, principal:banks[0]?.principal??2000000, termYears:banks[0]?.termYears??20, rate1:3.5, rate2:3.8, rate3:4.0, rateAfter:6.5, monthlyOverride:null, prepayPct:0.0, refiPref:"default", otherCosts:{ MRTA:0,"ค่าประเมิน":0,"ค่จดจำนอง":0,"ค่าธรรมเนียม":0,"ค่าปรับปิดก่อน":0 } }]);
  const removeBank=(i)=> setBanks(banks.filter((_,idx)=> idx!==i));
  const updateBank=(i,next)=> setBanks(banks.map((b,idx)=> idx===i? next: b));
  const moveBank=(i,dir)=>{ const j=i+dir; if(j<0||j>=banks.length) return; const arr=banks.slice(); [arr[i],arr[j]]=[arr[j],arr[i]]; setBanks(arr); };

  const onClickImport=()=> fileRef.current?.click();
  const onFileChange=async (e)=>{ const f=e.target.files?.[0]; if(!f) return; const text=await f.text(); const list=banksFromCSV(text); if(list.length===0){ alert("ไม่พบข้อมูลที่นำเข้า ตรวจสอบหัวตาราง/คอลัมน์อีกครั้ง"); return; } setBanks(list); e.target.value="";
  };

  const isSchedule=route.startsWith("#/schedule/"); const isInvest=route==="#/invest"; const isAnalysis=route==="#/analysis";
  let scheduleIndex=null; if(isSchedule){ const parts=route.split("/"); scheduleIndex=+parts[2]; }

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
    <div className={`mx-auto ${isInvest||isAnalysis? "p-2 md:p-3" : "p-4 md:p-6 max-w-6xl"}`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <div className="w-9 h-9 rounded-[10px] bg-gray-900 text-white grid place-items-center"><span className="mono">≡</span></div>
          <div>
            <div className="text-xl font-bold text-gray-900">ตัวช่วยเทียบรีไฟแนนซ์บ้าน</div>
            <div className="text-xs text-gray-500">ใส่ดอกเบี้ยปี 1–3, ค่างวดจริง, ค่าใช้จ่าย และโปะเพิ่ม (%)</div>
          </div>
        </div>

        {!isSchedule && !isInvest && !isAnalysis && (
          <div className="flex items-center gap-2">
            <label className="text-sm text-gray-600">Refinance:</label>
            <select className="ipt ipt-sm" value={refinanceBehavior} onChange={(e)=>setRefinanceBehavior(e.target.value)} aria-label="Refinance behavior">
              <option value="none">ไม่รีไฟแนนซ์</option>
              <option value="every3y">รีไฟแนนซ์ทุก 3 ปี</option>
              <option value="every5y">รีไฟแนนซ์ทุก 5 ปี</option>
            </select>

            {/* 🆕 Mortgage reg % */}
            <label className="text-sm text-gray-600">ค่าจดจำนอง %</label>
            <input className="ipt ipt-sm ipt-num mono" style={{width:90}} defaultValue={settings.regFeePct} onBlur={(e)=>setSettings({...settings, regFeePct: clamp3(parseMoneyInput(e.target.value))})}/>

            {/* 🆕 MRTA options */}
            <label className="text-sm text-gray-600 flex items-center gap-1">
              <input type="checkbox" checked={!!settings.includeMrtaInLoan} onChange={(e)=>setSettings({...settings, includeMrtaInLoan:e.target.checked})}/>
              MRTA in loan
            </label>
            <label className="text-sm text-gray-600">MRTA refund %</label>
            <input className="ipt ipt-sm ipt-num mono" style={{width:90}} defaultValue={settings.mrtaRefundPct} onBlur={(e)=>setSettings({...settings, mrtaRefundPct: clamp3(parseMoneyInput(e.target.value))})}/>

            <button className="btn-secondary ipt-sm" onClick={openInvest} title="Investment view" aria-label="Open Investment">Investment</button>
            <button className="btn-secondary ipt-sm" onClick={openAnalysis} title="Pro Analysis" aria-label="Open Pro Analysis">Pro Analysis</button>

            <input ref={fileRef} type="file" accept=".csv" style={{display:"none"}} onChange={onFileChange}/>
            <button className="btn-secondary icon-btn" onClick={downloadTemplateCSV} title="ดาวน์โหลดเทมเพลต CSV (Download)" aria-label="Download template"><IconDownload/></button>
            <button className="btn-secondary icon-btn" onClick={onClickImport} title="นำเข้า CSV (Upload)" aria-label="Upload CSV"><IconUpload/></button>
            <button className="btn icon-btn" onClick={addBank} title="เพิ่มธนาคาร" aria-label="Add bank"><IconPlus/></button>
          </div>
        )}
      </div>

      {/* หน้าเปรียบเทียบหลัก */}
      {!isSchedule && !isInvest && !isAnalysis && (
        <div className="space-y-6">
          <div className="space-y-4">
            {banks.map((b,i)=>(
              <BankEditor key={b.id} bank={b} onChange={(next)=>updateBank(i,next)} onRemove={()=>removeBank(i)} onMoveUp={()=>moveBank(i,-1)} onMoveDown={()=>moveBank(i,+1)} />
            ))}
          </div>

          <div className="space-y-3">
            <CompareTable banks={banks} refinanceBehavior={refinanceBehavior} onOpenSchedule={openSchedule} onToggleFocus={()=>setFocusCompare(v=>!v)} showFocus={focusCompare} settings={settings} />
            <div className="text-xs text-gray-500">
              หมายเหตุ: “รีเซ็ต 30 ปี” จะรีใหม่ครั้งแรกเมื่อถึงรอบรีไฟฯ (3 หรือ 5 ปี) • MRTA refund ใช้กับกรอบ 5 ปี (หลังรีฯ) •
              ค่าจดจำนอง % จะใช้เฉพาะกรณีไม่ได้กรอกตัวเลข “ค่าจดจำนอง (บาท)” ในการ์ดธนาคารนั้น ๆ
            </div>
          </div>
        </div>
      )}

      {/* Investment */}
      {isInvest && (
        <div className="space-y-4">
          <div className="flex items-center"><button className="btn-secondary ipt-sm" onClick={goHome} aria-label="Back">← กลับ</button></div>
          <InvestmentView banks={banks} refinanceBehavior={refinanceBehavior} onChangeRefiBehavior={setRefinanceBehavior} />
        </div>
      )}

      {/* Pro Analysis */}
      {isAnalysis && (
        <ProAnalysis banks={banks} refinanceBehavior={refinanceBehavior} onBack={goHome} />
      )}

      {/* Schedule */}
      {isSchedule && banks[scheduleIndex] && (
        <div className="space-y-4">
          <button className="btn-secondary ipt-sm" onClick={goHome} aria-label="Back">← กลับ</button>
          <ScheduleView bank={banks[scheduleIndex]} refinanceBehavior={refinanceBehavior} settings={settings} />
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
    list.push({ id:genId(), name:val(col.name), principal:toNumber(val(col.principal)), termYears:toNumber(val(col.termYears)), rate1:toNumber(val(col.rate1)), rate2:toNumber(val(col.rate2)), rate3:toNumber(val(col.rate3)), rateAfter:toNumber(val(col.rateAfter)), monthlyOverride: val(col.monthlyOverride)===""? null: toNumber(val(col.monthlyOverride)), prepayPct:toNumber(val(col.prepayPct)), refiPref:"default", otherCosts });
  }
  return list;
}

/* ========== Mount ========== */
const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<App />);
