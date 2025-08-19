const { useMemo, useState, useEffect, useRef } = React;

/* ========== Utils ========== */
const clamp2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const clamp3 = (n) => Math.round((n + Number.EPSILON) * 1000) / 1000;
const genId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`;
const fmtMoney = (n)=> Number(n||0).toLocaleString("th-TH",{minimumFractionDigits:2, maximumFractionDigits:2});
const fmtRate = (n)=> Number(n||0).toFixed(3);
function parseMoneyInput(str){ if(str==null) return 0; const v=Number(String(str).replace(/,/g,"").trim()); return isFinite(v)?v:0; }
function formatMoneyInput(v){ if(v===""||v==null) return ""; return fmtMoney(v); }
function pmt(r, n, P){ if(r===0) return P/n; const a=Math.pow(1+r,n); return (P*r*a)/(a-1); }

/* IRR (monthly) by bisection */
function irrMonthly(cashflows){
  // cashflows: [{t:0..N, cf:Number}]
  let lo=-0.99, hi=1.0; // monthly rate range
  const npv=(r)=> cashflows.reduce((s,x)=> s + x.cf/Math.pow(1+r, x.t), 0);
  let n=0, mid=0;
  for(; n<200; n++){
    mid=(lo+hi)/2;
    const v=npv(mid);
    if(Math.abs(v)<1e-6) break;
    const vLo=npv(lo);
    if(vLo*v<=0) hi=mid; else lo=mid;
  }
  return mid;
}
const yearize=(rM)=> (Math.pow(1+rM,12)-1);

/* ========== Core amortization ========== */
/** คำนวณแบบ "ตรึงค่างวดในช่วงดอก" (ค่าเริ่มต้น) + โปะ + เพดาน/เดือน */
function buildSchedule({
  principal,
  termMonths,
  rateSchedule,                 // [{months:12, rateYear:...}, ...]
  monthlyPaymentOverride = null,
  prepayPct = 0,                // โปะเพิ่มเป็น % ของค่างวด
  capPerMonth = null,           // เพดาน (ค่างวด+โปะ/ลงทุน) ต่อเดือน
  installmentMode = "fixPerBlock"
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

    // PMT ตรึงในบล็อก
    const basePay = monthlyPaymentOverride
      ? monthlyPaymentOverride
      : (r===0 ? balance/remaining : pmt(r, remaining, balance));

    for(let k=0;k<blockLen && balance>0;k++){
      const interest = balance * r;
      let principalPay = Math.max(0, basePay - interest);

      // ต้องการโปะจาก % ของค่างวด
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

/* ========== Refinance pattern ========== */
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

/* ========== ลงทุนรายเดือน + ทบต้นรายเดือน (ฐาน=ไม่โปะ) ========== */
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
// ทำให้เห็น "ขั้นบันไดค่างวด" ตามเคส Krungsri ที่ให้มา
const DEFAULT_BANKS = [
  { id: genId(), name:"Krungsri (ตัวอย่าง)", principal:2623000, termYears:20, rate1:1.25, rate2:2.50, rate3:4.27, rateAfter:5.37, monthlyOverride:null, prepayPct:0.0, otherCosts:{ MRTA:0,"ค่าประเมิน":0,"ค่าจดจำนอง":0,"ค่าธรรมเนียม":0,"ค่าปรับปิดก่อน":0 } },
  { id: genId(), name:"GSB (โปร Q3/2568)", principal:2623000, termYears:20, rate1:1.99, rate2:3.805, rate3:3.805, rateAfter:6.37, monthlyOverride:null, prepayPct:0.0, otherCosts:{ MRTA:0,"ค่าประเมิน":0,"ค่าจดจำนอง":0,"ค่าธรรมเนียม":1000,"ค่าปรับปิดก่อน":0 } },
];

/* ========== helpers ========== */
function L({ label, children }){ return (<label className="block text-sm"><div className="text-gray-600 mb-1">{label}</div>{children}</label>); }
function Th({ children, className="" }){ return <th className={`text-left ${className}`}>{children}</th>; }
function Td({ children, className="" }){ return <td className={`align-top ${className}`}>{children}</td>; }
function formatTerm(termMonths){ const y=Math.floor(termMonths/12), m=termMonths%12; return `${termMonths} งวด (${y} ปี${m?" "+m+" เดือน":""})`; }

/* ========== Schedule modal ========== */
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

  const exportCSV=()=>{ 
    const header=["เดือน","งวด","อัตราดอกเบี้ย(%)","ค่างวด","โปะเพิ่ม","เงินต้น","เงินต้นรวม","ดอกเบี้ย","คงเหลือ"].join(",");
    const body=schedule.rows
      .map((r,idx)=>[
        thaiMonthLabel(addMonthsYM(startYM, idx)), r.index, fmtRate(r.rate),
        r.payment.toFixed(2), r.extraPrepay.toFixed(2), r.principal.toFixed(2),
        r.principalTotal.toFixed(2), r.interest.toFixed(2), r.endBalance.toFixed(2)
      ].join(","))
      .join("\r\n");
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

/* ========== Dropdown Multi ========== */
function useOnClickOutside(ref, handler){
  useEffect(()=>{ 
    const listener=(e)=>{ if(!ref.current || ref.current.contains(e.target)) return; handler(e); };
    document.addEventListener('mousedown', listener); document.addEventListener('touchstart', listener);
    return ()=>{ document.removeEventListener('mousedown', listener); document.removeEventListener('touchstart', listener); };
  },[ref, handler]);
}
function DropdownMulti({ label, options, valueIds, onToggle, max=3 }){
  const [open, setOpen]=useState(false); const ref=useRef(null);
  useOnClickOutside(ref, ()=> setOpen(false));
  const selected=options.filter(o=>valueIds.includes(o.id));
  const title = selected.length ? `${label}: ${selected.map(s=>s.name).join(", ").slice(0,60)}${selected.map(s=>s.name).join(", ").length>60?"…":""}` : label;
  return (
    <div className="dropdown" ref={ref}>
      <button className="btn-secondary ipt-sm" onClick={()=>setOpen(v=>!v)} title={title} aria-haspopup="listbox" aria-expanded={open}>
        {selected.length? `${label} (${selected.length}/${max})` : label}
      </button>
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

/* ========== Compare Table (เพิ่ม Break-even / EIR) ========== */
function CompareTable({
  banks, refinanceBehavior, onOpenSchedule, onToggleFocus, showFocus,
  settings // {refiFeePerCycle, lockinMonths, preclosePenaltyPct, applyMortgageDeduction, taxRate, incomeNet, otherDebt}
}){
  const rows = useMemo(()=>{
    // base schedule (ธนาคารปัจจุบัน = index 0)
    const planned0=Math.round((banks[0]?.termYears||0)*12) || 0;
    const baseSched = banks[0] ? buildSchedule({
      principal:banks[0].principal, termMonths:planned0,
      rateSchedule:makeRateSchedule(banks[0], planned0, refinanceBehavior),
      monthlyPaymentOverride:banks[0].monthlyOverride, prepayPct:banks[0].prepayPct||0, installmentMode:"fixPerBlock"
    }) : {rows:[]};

    return banks.map((b,idx)=>{
      const planned=Math.round(b.termYears*12);
      const sched=buildSchedule({
        principal:b.principal, termMonths:planned,
        rateSchedule:makeRateSchedule(b, planned, refinanceBehavior),
        monthlyPaymentOverride:b.monthlyOverride, prepayPct:b.prepayPct||0, installmentMode:"fixPerBlock"
      });

      // รวม 3/5 ปี + อื่นๆ
      const first36=sched.rows.slice(0,36), first60=sched.rows.slice(0,60);
      let int3y=first36.reduce((s,r)=>s+r.interest,0);
      let int5y=first60.reduce((s,r)=>s+r.interest,0);

      // ภาษี/ลดหย่อนดอกบ้าน (คิดเป็น Cash benefit ~ taxRate * min(ดอกต่อปี, 100k)) — นำมาหักออกจาก "รวม"
      let taxBenefit3y=0, taxBenefit5y=0;
      if(settings.applyMortgageDeduction){
        const tax = Number(settings.taxRate||0)/100;
        const y1 = sched.rows.slice(0,12).reduce((s,r)=>s+r.interest,0);
        const y2 = sched.rows.slice(12,24).reduce((s,r)=>s+r.interest,0);
        const y3 = sched.rows.slice(24,36).reduce((s,r)=>s+r.interest,0);
        const y4 = sched.rows.slice(36,48).reduce((s,r)=>s+r.interest,0);
        const y5 = sched.rows.slice(48,60).reduce((s,r)=>s+r.interest,0);
        taxBenefit3y = tax*(Math.min(y1,100000)+Math.min(y2,100000)+Math.min(y3,100000));
        taxBenefit5y = taxBenefit3y + tax*(Math.min(y4,100000)+Math.min(y5,100000));
      }

      const other=sumOtherCosts(b.otherCosts);
      // ค่าธรรมเนียมรีไฟฯเกิดซ้ำ + ปรับปิดก่อน (คิดในงวดแรกของรอบ 36/60 เดือน)
      const cycleMonths = refinanceBehavior==="every3y" ? 36 : refinanceBehavior==="every5y" ? 60 : 0;
      let refiCostsByMonth = new Map(); // monthIndex (1-based) -> cost
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

      // Break-even: เทียบ "ประหยัดดอกสะสม" ของธนาคารนี้เมื่อเทียบฐาน (ธนาคาร 0)
      let breakEvenMonth = null;
      if(idx>0 && baseSched.rows.length){
        let cumSaved=0, cumRefiCost=other; // รวมค่าใช้จ่าย upfront
        for(let m=1; m<=Math.min(baseSched.rows.length, sched.rows.length); m++){
          const saved = Math.max(0, (baseSched.rows[m-1]?.interest||0) - (sched.rows[m-1]?.interest||0));
          cumSaved += saved;
          if(refiCostsByMonth.has(m)) cumRefiCost += refiCostsByMonth.get(m);
          if(cumSaved + 1e-6 >= cumRefiCost){ breakEvenMonth = m; break; }
        }
      }

      // รวม 3/5 ปี พร้อมหักผลประโยชน์จากภาษี
      const total3y = int3y + other - taxBenefit3y;
      const total5y = int5y + other - taxBenefit5y;

      // ทำ "ขั้นบันไดค่างวด"
      const stepPays=[]; let lastPay=null;
      for(const r of sched.rows){
        const pay=Math.round(r.payment);
        if(lastPay===null || Math.abs(pay-lastPay)>1){ stepPays.push(pay); lastPay=pay; }
        if(stepPays.length>=4) break;
      }
      const stepText = stepPays.map(v=>fmtMoney(v)).join(" → ");

      // EIR/IRR — กระแสเงินสดทั้งสัญญา (รวมค่าธรรมเนียม T0 + ค่าธรรมเนียมตามรอบ)
      const flows=[];
      flows.push({t:0, cf:+b.principal - other}); // เงินได้ - ค่าใช้จ่ายแรกเข้า
      sched.rows.forEach((r,i)=>{ // outflow รายเดือน
        flows.push({t:i+1, cf:-(r.payment + (r.extraPrepay||0))});
        const add = refiCostsByMonth.get(i+1); if(add) flows[flows.length-1].cf -= add;
      });
      const irrM = irrMonthly(flows);
      const eirYear = yearize(irrM);

      return {
        id:b.id, index:idx, name:b.name,
        stepText, prepay3y:first36.reduce((s,r)=>s+(r.extraPrepay||0),0),
        interest3y:int3y, total3y,
        prepay5y:first60.reduce((s,r)=>s+(r.extraPrepay||0),0),
        interest5y:int5y, total5y,
        after3yRate:b.rateAfter,
        payoffMonths:sched.rows.length,
        totalInterestAll:sched.totalInterest,
        otherCosts:other,
        breakEvenMonth,
        eirYear
      };
    });
  }, [banks, refinanceBehavior, settings]);

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
            <Th className="text-center">Break-even</Th>
            <Th className="text-right">EIR (ต่อปี)</Th>
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
                <Td className="text-center mono">{r.index===0? "—" : (r.breakEvenMonth? `เดือนที่ ${r.breakEvenMonth}`:"ยังไม่คุ้ม")}</Td>
                <Td className="text-right mono">{isFinite(r.eirYear)? ( (r.eirYear*100).toFixed(2)+"%" ) : "—"}</Td>
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

/* ========== Investment View (ตารางต่อปี + กราฟ) ========== */
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

  /* ---- chart (canvas 2D) ---- */
  useEffect(()=>{ if(!showChart) return;
    const canvas=canvasRef.current; if(!canvas) return; const ctx=canvas.getContext("2d");
    const pad=50; canvas.width=1000; canvas.height=450; ctx.clearRect(0,0,canvas.width,canvas.height);

    const sel=calcData.filter(d=>selectedIds.includes(d.id));
    const series = graphMode==="saved" ? sel.map(d=>d.chartSeries.saved) : sel.map(d=>d.chartSeries.totWith);
    const maxY = Math.max(1, ...series.flat());
    const maxX = Math.max(1, ...series.map(s=>s.length));

    const x=(i)=> pad + (canvas.width-2*pad)* (i/(maxX-1||1));
    const y=(v)=> canvas.height-pad - (canvas.height-2*pad)*(v/maxY);

    // axes
    ctx.strokeStyle="#d1d5db"; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(pad, pad); ctx.lineTo(pad, canvas.height-pad); ctx.lineTo(canvas.width-pad, canvas.height-pad); ctx.stroke();

    // lines
    const colors=["#111827","#4b5563","#9ca3af","#1f2937"];
    sel.forEach((d,di)=>{
      const s = graphMode==="saved" ? d.chartSeries.saved : d.chartSeries.totWith;
      ctx.strokeStyle=colors[di%colors.length]; ctx.lineWidth=2; ctx.beginPath();
      s.forEach((v,i)=>{ const xx=x(i); const yy=y(v); if(i===0) ctx.moveTo(xx,yy); else ctx.lineTo(xx,yy); }); ctx.stroke();
    });

    // simple hover tooltip
    const draw=(idx)=>{
      ctx.clearRect(0,0,canvas.width,canvas.height);
      // redraw axes + lines
      ctx.strokeStyle="#d1d5db"; ctx.lineWidth=1;
      ctx.beginPath(); ctx.moveTo(pad, pad); ctx.lineTo(pad, canvas.height-pad); ctx.lineTo(canvas.width-pad, canvas.height-pad); ctx.stroke();
      sel.forEach((d,di)=>{
        const s = graphMode==="saved" ? d.chartSeries.saved : d.chartSeries.totWith;
        ctx.strokeStyle=colors[di%colors.length]; ctx.lineWidth=2; ctx.beginPath();
        s.forEach((v,i)=>{ const xx=x(i); const yy=y(v); if(i===0) ctx.moveTo(xx,yy); else ctx.lineTo(xx,yy); }); ctx.stroke();
      });
      if(idx==null) return;
      const xx=x(idx);
      ctx.strokeStyle="#9ca3af"; ctx.beginPath(); ctx.moveTo(xx, pad); ctx.lineTo(xx, canvas.height-pad); ctx.stroke();
      // legend box
      const lines= sel.map((d)=>`${d.name}: ${fmtMoney((graphMode==="saved"? d.chartSeries.saved[idx]: d.chartSeries.totWith[idx])||0)}`);
      const text = `ปีที่ ${idx+1}\n`+lines.join("\n");
      ctx.fillStyle="rgba(255,255,255,.95)"; ctx.strokeStyle="#d1d5db"; ctx.lineWidth=1;
      const boxW=360, boxH=20*(lines.length+2); const bx=Math.min(xx+10, canvas.width-pad-boxW); const by=pad+10;
      ctx.fillRect(bx,by,boxW,boxH); ctx.strokeRect(bx,by,boxW,boxH);
      ctx.fillStyle="#111827"; ctx.font="12px ui-sans-serif";
      ctx.fillText(`ปีที่ ${idx+1}`, bx+8, by+18);
      lines.forEach((t,i)=> ctx.fillText(t, bx+8, by+18*(i+2)));
    };
    const onMove=(e)=>{ const r=canvas.getBoundingClientRect(); const t=(e.clientX-r.left); const i=Math.round((t-pad)/(canvas.width-2*pad)*(maxX-1)); if(i>=0&&i<maxX) draw(i); else draw(null); };
    const onLeave=()=>draw(null);
    canvas.addEventListener("mousemove", onMove); canvas.addEventListener("mouseleave", onLeave);
    draw(null);
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
          <select className="ipt ipt-sm" value={graphMode} onChange={e=>setGraphMode(e.target.value)}>
            <option value="saved">ประหยัดดอกสะสม</option>
            <option value="total">ดอกเบี้ยรวมสะสม</option>
          </select>
        </div>

        <div className="group">
          <label className="text-xs text-gray-600">โปะ/ลงทุน (% ค่างวด):</label>
          <input className="ipt ipt-sm mono" value={overridePrepayPct} onChange={(e)=>setOverridePrepayPct(e.target.value)} placeholder="เช่น 5" aria-label="Prepay percent" />
        </div>

        <div className="group">
          <label className="text-xs text-gray-600">เพดาน/เดือน (บาท):</label>
          <input className="ipt ipt-sm mono" value={monthlyCap} onChange={(e)=>setMonthlyCap(e.target.value)} placeholder="เช่น 16000" aria-label="Monthly cap" />
        </div>

        <div className="group">
          <label className="text-xs text-gray-600">คาดหวังผลตอบแทน/ปี (%):</label>
          <input className="ipt ipt-sm mono" value={expectReturn} onChange={(e)=>setExpectReturn(e.target.value)} aria-label="Expected return %" />
        </div>

        <button className="btn-secondary" onClick={()=>setShowChart(true)} aria-label="Open chart">ดูกราฟ</button>
        <button className="btn" onClick={exportCSV} aria-label="Export investment">Export</button>
      </div>

      {/* ตารางปี: sticky คอลัมน์ซ้าย + คั่นธนาคาร */}
      <div className="table-wrap sticky-first">
        <table className="min-w-full text-sm">
          <thead>
            <tr>
              <Th>รายการ / ปี</Th>
              {Array.from({length:maxYears},(_,i)=>(<Th key={`y${i}`} className="year-col text-right">ปีที่ {i+1}</Th>))}
            </tr>
          </thead>
          <tbody>
            {calcData.map((d,di)=>(
              <React.Fragment key={d.id}>
                {di>0 && <tr className="bank-divider"><td colSpan={maxYears+1}>ธนาคาร {d.name}</td></tr>}
                <tr>
                  <Td className="font-semibold">{d.name} — ประหยัดดอกสะสม</Td>
                  {Array.from({length:maxYears},(_,i)=>(<Td key={`saved-${di}-${i}`} className="text-right mono">{fmtMoney(d.chartSeries.saved[i]||0)}</Td>))}
                </tr>
                <tr>
                  <Td className="sub-label">ดอกเบี้ยรวมสะสม (แผนที่เลือก)</Td>
                  {Array.from({length:maxYears},(_,i)=>(<Td key={`tot-${di}-${i}`} className="text-right mono">{fmtMoney(d.chartSeries.totWith[i]||0)}</Td>))}
                </tr>
                <tr>
                  <Td className="sub-label">ดอกเบี้ยรวมสะสม (ไม่โปะ)</Td>
                  {Array.from({length:maxYears},(_,i)=>(<Td key={`cib-${di}-${i}`} className="text-right mono">{fmtMoney(d.years[i]?.cumInterestBase||0)}</Td>))}
                </tr>
                <tr>
                  <Td className="sub-label">เงินต้นลงทุนสะสม (ยอดลงทุนรายเดือน)</Td>
                  {Array.from({length:maxYears},(_,i)=>(<Td key={`cumInv-${di}-${i}`} className={`text-right mono ${d.years[i]?.capHitInvest?"cap-alert":""}`}>{fmtMoney(d.years[i]?.cumInvest||0)}</Td>))}
                </tr>
                <tr>
                  <Td className="sub-label">มูลค่าพอร์ตลงทุน (สิ้นปี)</Td>
                  {Array.from({length:maxYears},(_,i)=>(<Td key={`val-${di}-${i}`} className="text-right mono">{fmtMoney(d.years[i]?.investValue||0)}</Td>))}
                </tr>
                <tr>
                  <Td className="sub-label">กำไรลงทุนสะสม (แสดงในกราฟ)</Td>
                  {Array.from({length:maxYears},(_,i)=>(<Td key={`profit-${di}-${i}`} className="text-right mono">{fmtMoney(d.chartSeries.profit[i]||0)}</Td>))}
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
const IconDownload=()=>(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 3v12m0 0l-4-4m4 4l4-4"/><path d="M3 21h18"/></svg>);
const IconUpload=()=>(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 21V9m0 0l4 4m-4-4l-4 4"/><path d="M3 3h18"/></svg>);
const IconPlus=()=>(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 5v14M5 12h14"/></svg>);

function App(){
  const [banks, setBanks]=useLocalState("banks", DEFAULT_BANKS);
  const [refinanceBehavior, setRefinanceBehavior]=useLocalState("refiBehavior", "none");
  const [route, setRoute]=useState(location.hash||"");
  useEffect(()=>{ const onHash=()=>setRoute(location.hash||""); window.addEventListener("hashchange", onHash); return ()=>window.removeEventListener("hashchange", onHash); },[]);

  // Settings (รีไฟฯเกิดซ้ำ + ภาษี + DSR)
  const [settings, setSettings]=useLocalState("settings", {
    refiFeePerCycle: 0, lockinMonths: 0, preclosePenaltyPct: 0,
    applyMortgageDeduction:false, taxRate:10,
    incomeNet: 0, otherDebt: 0
  });

  const goHome=()=>{ location.hash=""; };
  const openSchedule=(idx)=>{ location.hash=`#/schedule/${idx}`; };
  const openInvest=()=>{ location.hash="#/invest"; };

  const isSchedule=route.startsWith("#/schedule/"); const isInvest=route==="#/invest"; 
  let scheduleIndex=null; if(isSchedule){ const parts=route.split("/"); scheduleIndex=+parts[2]; }

  /* Import/Export bank list */
  const fileRef=useRef(null);
  const onClickImport=()=> fileRef.current?.click();
  const onFileChange=(e)=>{
    const f=e.target.files?.[0]; if(!f) return;
    const reader=new FileReader();
    reader.onload=()=>{
      try{
        const lines=String(reader.result||"").trim().split(/\r?\n/);
        const [header, ...rows]=lines;
        const cols=header.split(",");
        const list=rows.map(line=>{
          const a=line.split(",");
          const obj={
            id: genId(),
            name:a[0], principal:+a[1], termYears:+a[2],
            rate1:+a[3], rate2:+a[4], rate3:+a[5], rateAfter:+a[6],
            monthlyOverride: (+a[7]||0)===0? null: +a[7],
            prepayPct:+a[8],
            otherCosts:{ MRTA:+a[9],"ค่าประเมิน":+a[10],"ค่าจดจำนอง":+a[11],"ค่าธรรมเนียม":+a[12],"ค่าปรับปิดก่อน":+a[13] }
          };
          return obj;
        });
        if(list.length) setBanks(list);
      }catch(err){ alert("อ่านไฟล์ไม่สำเร็จ"); }
    };
    reader.readAsText(f,"utf-8");
    e.target.value="";
  };
  const downloadTemplateCSV=()=>{
    const header=["name","principal","termYears","rate1","rate2","rate3","rateAfter","monthlyOverride","prepayPct","MRTA","ค่าประเมิน","ค่าจดจำนอง","ค่าธรรมเนียม","ค่าปรับปิดก่อน"].join(",");
    const sample=[
      "Krungsri (ตัวอย่าง),2623000,20,1.25,2.5,4.27,5.37,0,0,0,0,0,0",
      "GSB (โปร Q3/2568),2623000,20,1.99,3.805,3.805,6.37,0,0,0,0,1000,0"
    ].join("\r\n");
    const csv="\uFEFF"+header+"\r\n"+sample; 
    const blob=new Blob([csv],{type:"text/csv;charset=utf-8;"}); 
    const url=URL.createObjectURL(blob); 
    const a=document.createElement("a"); a.href=url; a.download="mortgage_template.csv"; a.click(); URL.revokeObjectURL(url);
  };

  // DSR indicator (ใช้ค่างวดสูงสุดของ bank แรกเป็นฐาน)
  const dsrInfo = useMemo(()=>{
    if(!banks[0]) return {pct:0, cls:"", txt:"—"};
    const planned=Math.round(banks[0].termYears*12);
    const sched=buildSchedule({
      principal:banks[0].principal, termMonths:planned,
      rateSchedule:makeRateSchedule(banks[0], planned, refinanceBehavior),
      monthlyPaymentOverride:banks[0].monthlyOverride, prepayPct:banks[0].prepayPct||0
    });
    const maxPay = Math.max(...sched.rows.map(r=>r.payment));
    const totalDebt = maxPay + Number(settings.otherDebt||0);
    const income = Math.max(1, Number(settings.incomeNet||0));
    const pct = totalDebt/income*100;
    const cls = pct<=35? "ok": pct<=50? "warn": "bad";
    const txt = `${pct.toFixed(1)}%`;
    return {pct, cls, txt};
  }, [banks, refinanceBehavior, settings.incomeNet, settings.otherDebt]);

  /* Mutations on bank list */
  const updateBank=(idx,next)=> setBanks(banks.map((b,i)=> i===idx? next : b));
  const removeBank=(idx)=> setBanks(banks.filter((_,i)=>i!==idx));
  const moveBank=(idx,delta)=> setBanks(banks.toSpliced(idx,1).toSpliced(Math.max(0, idx+delta),0,banks[idx]));
  const addBank=()=> setBanks([...banks, { ...DEFAULT_BANKS[0], id:genId(), name:"ธนาคารใหม่" }]);

  return (
    <div className={`mx-auto ${isInvest? "p-2 md:p-3" : "p-4 md:p-6 max-w-6xl"}`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <div className="w-9 h-9 rounded-[10px] bg-gray-900 text-white grid place-items-center"><span className="mono">≡</span></div>
          <div>
            <div className="text-xl font-bold text-gray-900">ตัวช่วยเทียบรีไฟแนนซ์บ้าน</div>
            <div className="text-xs text-gray-500">ใส่ดอกเบี้ยปี 1–3, ค่างวดจริง, ค่าใช้จ่าย และโปะเพิ่ม (%)</div>
          </div>
        </div>

        {/* ขวาบน: เฉพาะหน้า Home เท่านั้น (ไม่ซ้ำกับ Investment) */}
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

      {/* แถบ DSR + Settings สั้นๆ */}
      {!isInvest && (
        <div className="flex items-center gap-3 mb-3">
          <div className={`dsr ${dsrInfo.cls}`} title="Debt Service Ratio">
            DSR: {dsrInfo.txt}
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-600">รายได้สุทธิ/เดือน</label>
            <MoneyInput value={settings.incomeNet} onChange={(v)=>setSettings({...settings, incomeNet:v})}/>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-600">หนี้อื่น/เดือน</label>
            <MoneyInput value={settings.otherDebt} onChange={(v)=>setSettings({...settings, otherDebt:v})}/>
          </div>
        </div>
      )}

      {/* หน้าเปรียบเทียบหลัก */}
      {!isSchedule && !isInvest && (
        <div className="space-y-6">
          <div className="space-y-4">
            {banks.map((b,i)=>(
              <BankEditor key={b.id} bank={b} onChange={(next)=>updateBank(i,next)} onRemove={()=>removeBank(i)} onMoveUp={()=>moveBank(i,-1)} onMoveDown={()=>moveBank(i,+1)} />
            ))}
          </div>

          {/* ค่าธรรมเนียมรีไฟฯ/ภาษี */}
          <div className="grid md:grid-cols-3 grid-cols-1 gap-3">
            <div className="card p-3 border border-gray-200 rounded-xl bg-white">
              <div className="font-semibold mb-2">Refinance costs (ต่อรอบ)</div>
              <L label="refiFeePerCycle (บาท)"><MoneyInput value={settings.refiFeePerCycle} onChange={(v)=>setSettings({...settings, refiFeePerCycle:v})}/></L>
              <L label="lockinMonths (เดือน)"><MoneyInput value={settings.lockinMonths} onChange={(v)=>setSettings({...settings, lockinMonths:v})}/></L>
              <L label="preclosePenaltyPct (% ของเงินต้นคงเหลือ)"><RateInput value={settings.preclosePenaltyPct} onChange={(v)=>setSettings({...settings, preclosePenaltyPct:v})}/></L>
            </div>
            <div className="card p-3 border border-gray-200 rounded-xl bg-white">
              <div className="font-semibold mb-2">ภาษี/ลดหย่อน</div>
              <div className="flex items-center gap-2 mb-2">
                <input id="ded" type="checkbox" checked={!!settings.applyMortgageDeduction} onChange={(e)=>setSettings({...settings, applyMortgageDeduction:e.target.checked})}/>
                <label htmlFor="ded">ใช้สิทธิลดหย่อนดอกบ้าน ≤ 100,000/ปี</label>
              </div>
              <L label="อัตราภาษีที่จ่าย (% marginal)"><RateInput value={settings.taxRate} onChange={(v)=>setSettings({...settings, taxRate:v})}/></L>
              <div className="text-xs text-gray-500 mt-1">* หักเป็นประโยชน์ทางภาษีจากดอกเบี้ยที่จ่าย (ประมาณการ)</div>
            </div>
          </div>

          <div className="space-y-3">
            <CompareTable 
              banks={banks} refinanceBehavior={refinanceBehavior}
              onOpenSchedule={(idx)=>openSchedule(idx)} 
              onToggleFocus={()=>null} showFocus={false}
              settings={settings}
            />
            <div className="text-xs text-gray-500">หมายเหตุ: ระบบตรึงค่างวดตามช่วงอัตราดอก (คำนวณใหม่เมื่อเปลี่ยนอัตรา) • “โปะเพิ่ม (%)” จะคิดจากค่างวดแล้วตัดเงินต้นทันที • ตัวเลือก “Refinance” จะวนอัตราดอกตามรอบที่เลือก</div>
          </div>
        </div>
      )}

      {/* Investment (เต็มกว้าง) */}
      {isInvest && (
        <div className="space-y-4">
          <div className="flex items-center"><button className="btn-secondary ipt-sm" onClick={goHome} aria-label="Back">← กลับ</button></div>
          <InvestmentView banks={banks} refinanceBehavior={refinanceBehavior} onChangeRefiBehavior={setRefinanceBehavior}/>
        </div>
      )}

      {/* Schedule modal */}
      {isSchedule && banks[scheduleIndex] && (
        <div className="space-y-4">
          <div className="flex items-center"><button className="btn-secondary ipt-sm" onClick={goHome} aria-label="Back">← กลับ</button></div>
          <ScheduleView bank={banks[scheduleIndex]} refinanceBehavior={refinanceBehavior} />
        </div>
      )}
    </div>
  );
}

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

/* Mount App */
const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<App/>);
