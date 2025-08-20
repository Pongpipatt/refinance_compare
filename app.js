/* app.js — Combined FULL build (ตามข้อกำหนดล่าสุด)
 * ครอบคลุม:
 * 1) ปุ่ม “ดูรายละเอียดการคำนวณต่อเดือน” (PayDetailPopup) + ปุ่มเรียกในตาราง (onOpenPayDetail)
 * 2) ตรรกะรีไฟแนนซ์แบบ “รีตามปีคงเหลือ” (buildScheduleWithRemainRefi) และหยุดรีเมื่อหนี้ < 1,000,000
 * 3) ปุ่มเลือกรีรายธนาคาร (refiPref) คงอยู่
 * 4) InvestmentPanel: จุดตัด “หนี้คงเหลือแบบไม่โปะ” vs “มูลค่าพอร์ตลงทุน”
 */

const { useMemo, useState, useEffect, useRef } = React;

/* ===================== Utils ===================== */
const toNumber = (v) => (isFinite(+v) ? +v : 0);
const clamp2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const clamp3 = (n) => Math.round((n + Number.EPSILON) * 1000) / 1000;
function pmt(r, n, P){ if(r===0) return P/n; const a=Math.pow(1+r,n); return (P*r*a)/(a-1); }
const genId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`;
const fmtMoney = (n)=> Number(n||0).toLocaleString("th-TH",{minimumFractionDigits:2, maximumFractionDigits:2});
const fmtRate = (n)=> Number(n||0).toFixed(3);
const fmtInt = (n)=> Number(n||0).toLocaleString("th-TH");
function parseMoneyInput(str){ if(str==null) return 0; const v=Number(String(str).replace(/,/g,"").trim()); return isFinite(v)?v:0; }
function formatMoneyInput(v){ if(v===""||v==null) return ""; return fmtMoney(v); }

/* IRR helpers (คงไว้เผื่อหน้า Pro/Advanced ที่มีอยู่แล้ว) */
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

/* ===================== Core amortization ===================== */
function buildSchedule({
  principal,
  termMonths,
  rateSchedule,
  monthlyPaymentOverride = null,
  prepayPct = 0,
  capPerMonth = null,
}){
  let balance = principal;
  const rows = [];

  // flatten block schedule -> months
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

      // โปะเพิ่มจาก basePay (optional) + เคารพ Cap/เดือน
      const desiredExtra = Math.max(0, basePay*(prepayPct/100));
      let allowedExtra = desiredExtra;
      let extraCapped = false;
      if(capPerMonth && capPerMonth>0){
        const room = Math.max(0, capPerMonth - basePay);
        if(desiredExtra > room + 1e-9){ allowedExtra = room; extraCapped = true; }
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
  const totalPayment  = rows.reduce((s,r)=>s+r.payment+(r.extraPrepay||0),0);
  return { rows, totalInterest, totalPayment, endBalance: balance };
}

function sumOtherCosts(otherCosts){ return Object.values(otherCosts||{}).reduce((s,v)=>s+Number(v||0),0); }

/* ===================== Rate helpers ===================== */
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

/* ===================== Refi-by-remaining (หยุดถ้า balance < 1,000,000) ===================== */
/* NOTE: ไม่ reset อายุสัญญาเป็น 30 ปีทุกครั้ง — ใช้รอบรี 36/60 เดือน แล้วลด term เหลือจริง */
function buildScheduleWithRemainRefi({ bank, termMonths, refinanceBehavior, prepayPct=0, capPerMonth=null }){
  const cycle = refinanceBehavior==="every3y" ? 36 : refinanceBehavior==="every5y" ? 60 : 0;
  const _principal = bank._principalAdj ?? bank.principal;

  if(cycle<=0){
    return buildSchedule({
      principal:_principal,
      termMonths,
      rateSchedule: makeRateSchedule(bank, termMonths, effectiveBehavior(bank.refiPref, refinanceBehavior)),
      monthlyPaymentOverride: bank.monthlyOverride,
      prepayPct, capPerMonth
    });
  }

  let rows = [];
  let balance = _principal;
  let monthsLeft = termMonths;

  while(monthsLeft>0 && balance>0){
    const segLen = Math.min(cycle, monthsLeft);

    // สร้างตารางช่วงนี้ (ใช้โปรปี 1–3 ของธนาคารตาม behavior)
    const seg = buildSchedule({
      principal: balance,
      termMonths: segLen,
      rateSchedule: makeRateSchedule(bank, segLen, refinanceBehavior),
      monthlyPaymentOverride: bank.monthlyOverride,
      prepayPct, capPerMonth
    });
    rows.push(...seg.rows.map((r,i)=>({...r, index: rows.length+i+1})));
    balance = seg.endBalance;
    monthsLeft -= segLen;

    if(monthsLeft<=0 || balance<=0) break;

    // หยุดรีเมื่อหนี้ต่ำกว่า 1,000,000 — ที่เหลือคิดด้วยอัตราหลังโปรจนจบ (behavior="none")
    if(balance < 1_000_000){
      const tail = buildSchedule({
        principal: balance,
        termMonths: monthsLeft,
        rateSchedule: makeRateSchedule(bank, monthsLeft, "none"),
        monthlyPaymentOverride: bank.monthlyOverride,
        prepayPct, capPerMonth
      });
      rows.push(...tail.rows.map((r,i)=>({...r, index: rows.length+i+1})));
      balance = tail.endBalance;
      monthsLeft = 0;
      break;
    }
  }

  const totalInterest = rows.reduce((s,r)=>s+r.interest,0);
  const totalPayment  = rows.reduce((s,r)=>s+r.payment+(r.extraPrepay||0),0);
  const endBalance = rows.length ? rows[rows.length-1].endBalance : 0;
  return { rows, totalInterest, totalPayment, endBalance };
}

/* ===================== Inputs ===================== */
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

/* ===================== Defaults ===================== */
const DEFAULT_BANKS = [
  {
    id: genId(), name:"กรุงศรี (ปัจจุบัน)",
    principal:2623000, termYears:20,
    rate1:5.37, rate2:5.37, rate3:5.37, rateAfter:5.37,
    monthlyOverride:null, prepayPct:0.0, refiPref:"default",
    includeMrtaInLoan:false, mrtaRefund3yPct:60, mrtaRefund5yPct:40,
    otherCosts:{ MRTA:0,"ค่าประเมิน":0,"ค่าจดจำนอง":0,"ค่าธรรมเนียม":0,"ค่าปรับปิดก่อน":0 }
  },
  {
    id: genId(), name:"ออมสิน (โปร Q3/2568)",
    principal:2623000, termYears:20,
    rate1:1.99, rate2:3.805, rate3:3.805, rateAfter:6.37,
    monthlyOverride:null, prepayPct:0.0, refiPref:"default",
    includeMrtaInLoan:false, mrtaRefund3yPct:60, mrtaRefund5yPct:40,
    otherCosts:{ MRTA:0,"ค่าประเมิน":0,"ค่าจดจำนอง":0,"ค่าธรรมเนียม":1000,"ค่าปรับปิดก่อน":0 }
  },
];

/* ===================== Small helpers ===================== */
function L({ label, children }){ return (<label className="block text-sm"><div className="text-gray-600 mb-1">{label}</div>{children}</label>); }
function Th({ children, className="" }){ return <th className={`text-left ${className}`}>{children}</th>; }
function Td({ children, className="" }){ return <td className={`align-top ${className}`}>{children}</td>; }
function formatTerm(termMonths){ const y=Math.floor(termMonths/12), m=termMonths%12; return `${termMonths} งวด (${y} ปี${m?" "+m+" เดือน":""})`; }

/* ===================== DropdownMulti ===================== */
function DropdownMulti({ label, options, valueIds, onToggle, max=99 }){
  const [open, setOpen] = useState(false);
  const ids = new Set(valueIds||[]);
  const onChange=(id)=> onToggle(id);
  return (
    <div className="dropdown">
      <button className="btn-secondary ipt-sm" onClick={()=>setOpen(v=>!v)} aria-expanded={open}>{label}</button>
      {open && (
        <div className="dropdown-menu" role="menu" onClick={(e)=>e.stopPropagation()}>
          {options.map(opt=>{
            const id=opt.id??opt.value??opt; const name=opt.name??opt.label??String(opt);
            const checked=ids.has(id);
            return (
              <div key={id} className="item">
                <input type="checkbox" checked={checked} onChange={()=>onChange(id)} />
                <div className="truncate">{name}</div>
              </div>
            );
          })}
          <div className="dropdown-footer">เลือกได้สูงสุด {max} รายการ</div>
        </div>
      )}
    </div>
  );
}

/* ===================== BankEditor (คืนตัวเลือกรีรายธนาคาร) ===================== */
function BankEditor({ bank, onChange, onRemove, onMoveUp, onMoveDown }){
  const set=(patch)=> onChange({...bank, ...patch});
  const setOC=(k,v)=> onChange({...bank, otherCosts:{...(bank.otherCosts||{}), [k]:v}});
  return (
    <div className="controls-card">
      <div className="grid md:grid-cols-4 gap-3">
        <L label="ชื่อธนาคาร">
          <input className="ipt" defaultValue={bank.name} onBlur={(e)=>set({name:e.target.value})}/>
        </L>
        <L label="วงเงินคงเหลือ (บาท)">
          <MoneyInput value={bank.principal} onChange={(v)=>set({principal:v})}/>
        </L>
        <L label="ระยะเวลาที่เหลือ (ปี)">
          <input className="ipt ipt-num mono" defaultValue={bank.termYears} onBlur={(e)=>set({termYears:toNumber(e.target.value)})}/>
        </L>
        <L label="Refinance (รายธนาคาร)">
          <select className="ipt" value={bank.refiPref||"default"} onChange={(e)=>set({refiPref:e.target.value})}>
            <option value="default">ใช้ค่าหน้าแรก</option>
            <option value="none">ไม่รีไฟแนนซ์</option>
            <option value="every3y">รีทุก 3 ปี</option>
            <option value="every5y">รีทุก 5 ปี</option>
          </select>
        </L>

        <L label="ดอกปี 1 (%)"><RateInput value={bank.rate1} onChange={(v)=>set({rate1:v})}/></L>
        <L label="ดอกปี 2 (%)"><RateInput value={bank.rate2} onChange={(v)=>set({rate2:v})}/></L>
        <L label="ดอกปี 3 (%)"><RateInput value={bank.rate3} onChange={(v)=>set({rate3:v})}/></L>
        <L label="หลังปี 3 เป็นต้นไป (%)"><RateInput value={bank.rateAfter} onChange={(v)=>set({rateAfter:v})}/></L>

        <L label="ค่างวดจริง/เดือน (ถ้ามี)">
          <MoneyInput value={bank.monthlyOverride??0} onChange={(v)=>set({monthlyOverride:(v||v===0)? (v>0?v:null):null})}/>
        </L>
        <L label="ตั้งใจโปะเพิ่ม (%)">
          <input className="ipt ipt-num mono" defaultValue={bank.prepayPct} onBlur={(e)=>set({prepayPct:toNumber(e.target.value)})}/>
        </L>
        <L label="รวม MRTA เข้าเงินกู้ ?">
          <select className="ipt" value={bank.includeMrtaInLoan? "true":"false"} onChange={(e)=>set({includeMrtaInLoan:e.target.value==="true"})}>
            <option value="false">ไม่รวม</option>
            <option value="true">รวม</option>
          </select>
        </L>
        <div className="flex items-end gap-2">
          <button className="btn-secondary" onClick={onMoveUp}>↑ ย้ายขึ้น</button>
          <button className="btn-secondary" onClick={onMoveDown}>↓ ย้ายลง</button>
          <button className="btn text-red-600" onClick={onRemove}>ลบ</button>
        </div>

        <L label="MRTA (บาท)"><MoneyInput value={(bank.otherCosts||{}).MRTA||0} onChange={(v)=>setOC("MRTA",v)}/></L>
        <L label="ค่าประเมิน"><MoneyInput value={(bank.otherCosts||{})["ค่าประเมิน"]||0} onChange={(v)=>setOC("ค่าประเมิน",v)}/></L>
        <L label="ค่าจดจำนอง"><MoneyInput value={(bank.otherCosts||{})["ค่าจดจำนอง"]||0} onChange={(v)=>setOC("ค่าจดจำนอง",v)}/></L>
        <L label="ค่าธรรมเนียมอื่น"><MoneyInput value={(bank.otherCosts||{})["ค่าธรรมเนียม"]||0} onChange={(v)=>setOC("ค่าธรรมเนียม",v)}/></L>

        <L label="สัดส่วนเวนคืน MRTA ปีที่ 3 (%)">
          <input className="ipt ipt-num mono" defaultValue={bank.mrtaRefund3yPct??60} onBlur={(e)=>set({mrtaRefund3yPct:toNumber(e.target.value)})}/>
        </L>
        <L label="สัดส่วนเวนคืน MRTA ปีที่ 5 (%)">
          <input className="ipt ipt-num mono" defaultValue={bank.mrtaRefund5yPct??40} onBlur={(e)=>set({mrtaRefund5yPct:toNumber(e.target.value)})}/>
        </L>
      </div>
    </div>
  );
}

/* ===================== CompareTable (มีปุ่ม “รายละเอียดค่างวด”) ===================== */
function CompareTable({ banks, refinanceBehavior, onOpenSchedule, onOpenPayDetail, onToggleFocus, showFocus }){
  const rows = useMemo(()=>{
    return banks.map((b,idx)=>{
      const planned=Math.round((b.termYears||0)*12);
      const eff = effectiveBehavior(b.refiPref, refinanceBehavior);

      // รวม MRTA เข้าเงินกู้ถ้าเลือก
      const mrta = Number((b.otherCosts||{}).MRTA||0);
      const principalAdj = Number(b.principal||0) + (b.includeMrtaInLoan ? mrta : 0);

      const sched = buildScheduleWithRemainRefi({
        bank:{...b, _principalAdj: principalAdj},
        termMonths:planned,
        refinanceBehavior: eff,
        prepayPct: b.prepayPct||0
      });

      // step payments (แสดง 3–4 ช่วงแรก)
      const stepPays=[]; let lastPay=null;
      for(const r of sched.rows){
        const pay=Math.round(r.payment);
        if(lastPay===null || Math.abs(pay-lastPay)>1){ stepPays.push(pay); lastPay=pay; }
        if(stepPays.length>=4) break;
      }

      // ดอกสะสมช่วง 3 ปี / 5 ปี
      const int3 = sched.rows.slice(0,36).reduce((s,r)=>s+r.interest,0);
      const int5 = sched.rows.slice(0,60).reduce((s,r)=>s+r.interest,0);

      // ค่าใช้จ่ายอื่น (หักเวนคืน MRTA สำหรับกรอบ 3/5 ปี)
      const other = sumOtherCosts(b.otherCosts);
      const refund3 = Math.max(0, (b.mrtaRefund3yPct||0)/100 * ((b.otherCosts||{}).MRTA||0));
      const refund5 = Math.max(0, (b.mrtaRefund5yPct||0)/100 * ((b.otherCosts||{}).MRTA||0));
      const other3 = Math.max(0, other - refund3);
      const other5 = Math.max(0, other - refund5);

      return {
        id:b.id, idx,
        name:b.name,
        stepText: stepPays.map(v=>fmtMoney(v)).join(" → "),
        int3, int5,
        other3, other5,
        total3: int3 + other3,
        total5: int5 + other5,
        payoffMonths: sched.rows.length,
        effRefi: eff
      };
    });
  }, [banks, refinanceBehavior]);

  const best3 = rows.length? Math.min(...rows.map(r=>r.total3)) : null;
  const best5 = rows.length? Math.min(...rows.map(r=>r.total5)) : null;

  return (
    <div className="table-wrap">
      <table className="min-w-full text-sm">
        <thead>
          <tr>
            <Th>ธนาคาร</Th>
            <Th className="text-right">ค่างวด/เดือน (ตามบล็อกดอก)</Th>
            <Th className="text-right">ดอก 3 ปี</Th>
            <Th className="text-right">อื่น ๆ*</Th>
            <Th className="text-right">รวม 3 ปี</Th>
            <Th className="text-right">ดอก 5 ปี</Th>
            <Th className="text-right">อื่น ๆ*</Th>
            <Th className="text-right">รวม 5 ปี</Th>
            <Th className="text-right">งวดที่เหลือ</Th>
            <Th className="text-center">เครื่องมือ</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r=>{
            const cls3 = r.total3===best3? "cell-min" : "";
            const cls5 = r.total5===best5? "cell-min" : "";
            return (
              <tr key={r.id}>
                <Td>
                  <div className="font-semibold">{r.name}</div>
                  <div className="text-xs text-gray-500">Refi: {r.effRefi==="none"?"ไม่รี": r.effRefi==="every3y"?"ทุก 3 ปี": r.effRefi==="every5y"?"ทุก 5 ปี":"ตามหน้าแรก"}</div>
                </Td>
                <Td className="text-right mono">{r.stepText||"—"}</Td>
                <Td className="text-right mono">{fmtMoney(r.int3)}</Td>
                <Td className="text-right mono">{fmtMoney(r.other3)}</Td>
                <Td className="text-right mono"><span className={cls3}>{fmtMoney(r.total3)}</span></Td>
                <Td className="text-right mono">{fmtMoney(r.int5)}</Td>
                <Td className="text-right mono">{fmtMoney(r.other5)}</Td>
                <Td className="text-right mono"><span className={cls5}>{fmtMoney(r.total5)}</span></Td>
                <Td className="text-right mono">{formatTerm(r.payoffMonths)}</Td>
                <Td className="text-center">
                  <div className="flex flex-wrap gap-2 justify-end">
                    <button className="btn-secondary ipt-sm" onClick={()=>onOpenSchedule(r.idx)}>ตารางผ่อน</button>
                    <button className="btn ipt-sm" onClick={()=>onOpenPayDetail(r.idx)}>ดูรายละเอียดค่างวด</button>
                  </div>
                </Td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="text-xs text-gray-500 p-2">
        * “อื่น ๆ” = ค่าใช้จ่ายรวม หักเงินเวนคืน MRTA ตามสัดส่วนที่ตั้งไว้สำหรับกรอบ 3/5 ปี
      </div>
      <div className="flex items-center gap-2 p-2">
        <button className="btn-secondary ipt-sm" onClick={onToggleFocus}>{showFocus? "ซ่อนตาราง":"โฟกัสตาราง"}</button>
      </div>
    </div>
  );
}

/* ===================== Schedule View (รายเดือน) ===================== */
function ScheduleView({ bank, refinanceBehavior }){
  const planned=Math.round((bank.termYears||0)*12);
  const mrta = Number((bank.otherCosts||{}).MRTA||0);
  const principalAdj = Number(bank.principal||0) + (bank.includeMrtaInLoan ? mrta : 0);
  const eff = effectiveBehavior(bank.refiPref, refinanceBehavior);

  const sched = useMemo(()=>buildScheduleWithRemainRefi({
    bank:{...bank, _principalAdj: principalAdj},
    termMonths:planned,
    refinanceBehavior: eff,
    prepayPct: bank.prepayPct||0
  }), [bank, principalAdj, planned, eff]);

  return (
    <div className="table-wrap">
      <table className="min-w-full text-sm">
        <thead>
          <tr>
            <Th>งวด</Th>
            <Th className="text-right">ดอก (%)</Th>
            <Th className="text-right">ค่างวด</Th>
            <Th className="text-right">โปะเพิ่ม</Th>
            <Th className="text-right">ดอกเบี้ย</Th>
            <Th className="text-right">ตัดต้น</Th>
            <Th className="text-right">หนี้คงเหลือ</Th>
          </tr>
        </thead>
        <tbody>
          {sched.rows.map((r,i)=>(
            <tr key={i}>
              <Td>{i+1}</Td>
              <Td className="text-right mono">{fmtRate(r.rate)}</Td>
              <Td className="text-right mono">{fmtMoney(r.payment)}</Td>
              <Td className="text-right mono">{fmtMoney(r.extraPrepay||0)}</Td>
              <Td className="text-right mono">{fmtMoney(r.interest)}</Td>
              <Td className="text-right mono">{fmtMoney(r.principalTotal - r.interest)}</Td>
              <Td className="text-right mono">{fmtMoney(r.endBalance)}</Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ===================== PayDetailPopup (ปุ่มดูรายละเอียดการคำนวณต่อเดือน) ===================== */
/* แสดง “บล็อกค่างวด base คงที่” จากอัตราดอก/รีไฟแนนซ์ โดยไม่แตะ logic อื่น */
function PayDetailPopup({ bank, refinanceBehavior, onClose }) {
  const termMonths = Math.round(bank.termYears * 12);

  // ปรับ principal ถ้ารวม MRTA เข้าเงินกู้ (สอดคล้องกับ CompareTable)
  const mrta = Number((bank.otherCosts || {}).MRTA || 0);
  const principalAdj = Number(bank.principal || 0) + (bank.includeMrtaInLoan ? mrta : 0);
  const eff = effectiveBehavior(bank.refiPref, refinanceBehavior);

  const sched = React.useMemo(
    () =>
      buildScheduleWithRemainRefi({
        bank: { ...bank, _principalAdj: principalAdj },
        termMonths,
        refinanceBehavior: eff,
        prepayPct: bank.prepayPct || 0,
      }),
    [bank, principalAdj, termMonths, eff]
  );

  // รวมเป็น segment ตาม “ค่างวด base” ที่คงที่ ภายในบล็อก
  const segs = [];
  let curr = null;
  let startBalance = principalAdj;
  sched.rows.forEach((r, idx) => {
    const pay = Math.round(r.payment * 100) / 100;
    if (!curr || Math.abs(pay - curr.payment) > 0.009) {
      if (curr) {
        curr.endBalance = sched.rows[idx - 1].endBalance;
        segs.push(curr);
      }
      curr = {
        no: segs.length + 1,
        startIndex: r.index,
        months: 1,
        rate: r.rate,
        payment: pay,
        startBalance: startBalance,
        endBalance: r.endBalance,
      };
    } else {
      curr.months += 1;
      curr.rate = r.rate;
      curr.endBalance = r.endBalance;
    }
    startBalance = r.endBalance;
  });
  if (curr) segs.push(curr);

  return (
    <div className="focus-layer" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="focus-box" onClick={(e) => e.stopPropagation()}>
        <div className="focus-head">
          <div className="font-semibold">รายละเอียดคำนวณค่างวด: {bank.name}</div>
          <button className="focus-close" onClick={onClose}>✕ ปิด</button>
        </div>
        <div className="focus-body">
          <div className="table-wrap">
            <table className="min-w-full text-sm">
              <thead>
                <tr>
                  <Th className="text-right">ช่วง</Th>
                  <Th className="text-right">งวดเริ่ม</Th>
                  <Th className="text-right">จำนวนเดือน</Th>
                  <Th className="text-right">อัตราดอกเบี้ย (%)</Th>
                  <Th className="text-right">ค่างวด/เดือน (base)</Th>
                  <Th className="text-right">หนี้ต้นช่วงต้น</Th>
                  <Th className="text-right">หนี้ปลายช่วง</Th>
                </tr>
              </thead>
              <tbody>
                {segs.map((s) => (
                  <tr key={s.no}>
                    <Td className="text-right mono">{s.no}</Td>
                    <Td className="text-right mono">{s.startIndex}</Td>
                    <Td className="text-right mono">{s.months}</Td>
                    <Td className="text-right mono">{fmtRate(s.rate)}</Td>
                    <Td className="text-right mono">{fmtMoney(s.payment)}</Td>
                    <Td className="text-right mono">{fmtMoney(s.startBalance)}</Td>
                    <Td className="text-right mono">{fmtMoney(s.endBalance)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="text-sm text-gray-600 mt-2">
            หมายเหตุ: ค่างวด(base) จะคงที่ภายในแต่ละบล็อก (เปลี่ยนเมื่ออัตราดอกเบี้ยหรือรอบรีไฟแนนซ์เปลี่ยน) การโปะเพิ่มคิดแยกต่างหาก ไม่ทำให้ค่างวด base เปลี่ยน
          </div>
        </div>
      </div>
    </div>
  );
}

/* ===================== Investment (จุดตัด: หนี้ “ไม่โปะ” vs มูลค่าพอร์ต) ===================== */
/**
 * computeInvestmentSeriesMonthly
 * @param {Array} baseRows - schedule "ไม่โปะ" (ใช้ค่างวดฐานเป็นตัวตั้ง)
 * @param {number} prepayPct - % ของค่างวดฐาน ที่ “เดิมจะโปะ” แต่ในโหมดลงทุน = เอาไปลงทุนแทน
 * @param {number|null} capPerMonth - เพดาน (ค่างวดฐาน + เงินลงทุน) ต่อเดือน; ถ้า null = ไม่จำกัด
 * @param {string|number} expectReturnYearPct - ผลตอบแทนคาดหวัง % ต่อปี
 * @returns {Array} ต่อปี: { investValue, investProfit, cumInvest, capHitInvest }
 */
function computeInvestmentSeriesMonthly(baseRows, prepayPct, capPerMonth, expectReturnYearPct){
  const rYear = Number(expectReturnYearPct||0)/100;
  const rMonth = Math.pow(1+rYear, 1/12)-1;

  let investValue=0, cumInvest=0, investProfit=0, capHitFlagYear=false;
  const years=[];

  baseRows.forEach((row, idx)=>{
    const basePay = row.payment; // ค่างวดฐาน (ไม่โปะ)
    let invest = Math.max(0, basePay * (prepayPct/100)); // เงินที่จะโปะ → ลงทุนแทน

    if(capPerMonth && capPerMonth>0){
      const room = Math.max(0, capPerMonth - basePay);
      if(invest > room + 1e-9){ invest = room; capHitFlagYear = true; }
    }

    // ลงทุนต้นใหม่ + ทบกำไร
    investValue = (investValue + invest) * (1 + rMonth);
    cumInvest += invest;

    // กำไรโดยประมาณ = มูลค่า - เงินต้นลงทุนสะสม
    investProfit = Math.max(0, investValue - cumInvest);

    // ปิดสิ้นปี
    const isYearEnd = ((idx+1) % 12 === 0) || (idx === baseRows.length-1);
    if(isYearEnd){
      years.push({
        investValue,
        investProfit,
        cumInvest,
        capHitInvest: capHitFlagYear
      });
      capHitFlagYear=false;
    }
  });

  return years;
}

function InvestmentPanel({ bank, refinanceBehavior }) {
  // baseline: “ไม่โปะ”
  const termMonths = Math.round(bank.termYears * 12);
  const eff = effectiveBehavior(bank.refiPref, refinanceBehavior);

  const baseSched = React.useMemo(
    () =>
      buildScheduleWithRemainRefi({
        bank,
        termMonths,
        refinanceBehavior: eff,
        prepayPct: 0,
      }),
    [bank, termMonths, eff]
  );

  // ลงทุนแทนโปะ (ใช้ prepayPct ของธนาคารนั้น)
  const expectReturn = 7; // ตัวอย่าง: 7%/ปี (ผู้ใช้ปรับที่อื่นได้ถ้ามี UI)
  const investSeries = React.useMemo(
    () =>
      computeInvestmentSeriesMonthly(baseSched.rows, bank.prepayPct || 0, null, expectReturn),
    [baseSched.rows, bank.prepayPct, expectReturn]
  );

  // สร้าง series “หนี้คงเหลือปลายปี” จาก baseline (ไม่โปะ)
  const yearlyBaseBalance = React.useMemo(() => {
    const arr = [];
    for (let i = 0; i < baseSched.rows.length; i++) {
      const isYearEnd = ((i + 1) % 12 === 0) || i === baseSched.rows.length - 1;
      if (isYearEnd) arr.push({ yearIndex: arr.length + 1, balance: baseSched.rows[i].endBalance });
    }
    return arr;
  }, [baseSched.rows]);

  // หา “จุดตัด”: ปีแรกที่ พอร์ตลงทุน >= หนี้คงเหลือ (baseline)
  const cross = React.useMemo(() => {
    const n = Math.min(yearlyBaseBalance.length, investSeries.length);
    for (let i = 0; i < n; i++) {
      if ((investSeries[i]?.investValue || 0) >= (yearlyBaseBalance[i]?.balance || Infinity)) {
        return { yearIndex: i + 1, investValue: investSeries[i].investValue, balance: yearlyBaseBalance[i].balance };
      }
    }
    return null;
  }, [yearlyBaseBalance, investSeries]);

  return (
    <div className="controls-card">
      <div className="text-lg font-semibold mb-2">ลงทุนแทนการโปะ — จุดตัดพอร์ต vs หนี้ “ไม่โปะ”</div>
      <div className="table-wrap">
        <table className="min-w-full text-sm">
          <thead>
            <tr>
              <Th className="text-right">ปี</Th>
              <Th className="text-right">มูลค่าพอร์ตลงทุน</Th>
              <Th className="text-right">หนี้คงเหลือ (ไม่โปะ)</Th>
              <Th className="text-center">สถานะ</Th>
            </tr>
          </thead>
          <tbody>
            {yearlyBaseBalance.map((y, i) => {
              const inv = investSeries[i] || { investValue: 0 };
              const hit = inv.investValue >= y.balance;
              return (
                <tr key={y.yearIndex}>
                  <Td className="text-right mono">{y.yearIndex}</Td>
                  <Td className="text-right mono">{fmtMoney(inv.investValue)}</Td>
                  <Td className="text-right mono">{fmtMoney(y.balance)}</Td>
                  <Td className="text-center">{hit ? <span className="cell-min">พอร์ต ≥ หนี้</span> : "—"}</Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="text-sm mt-2">
        ผลลัพธ์นี้อิง: <b>หนี้คงเหลือแบบไม่โปะ</b> เทียบกับ <b>พอร์ตลงทุน</b> ที่นำเงิน “โปะ” ไปลงทุนแทน (ตาม requirement)
        {cross ? (
          <div className="mt-1">
            ✅ จุดตัดเกิดในปีที่ <b>{cross.yearIndex}</b> — พอร์ต {fmtMoney(cross.investValue)} ≥ หนี้ {fmtMoney(cross.balance)}
          </div>
        ) : (
          <div className="mt-1">ยังไม่พบจุดตัดภายในระยะเวลาสัญญาที่เหลือ</div>
        )}
      </div>
    </div>
  );
}

/* ===================== App ===================== */
function App(){
  const [banks, setBanks] = React.useState(DEFAULT_BANKS);
  const [refinanceBehavior, setRefinanceBehavior] = React.useState("every3y"); // ค่าเริ่มต้นรวม
  const [showFocus, setShowFocus] = React.useState(false);

  const [scheduleIndex, setScheduleIndex] = React.useState(null);   // เปิดตารางผ่อน
  const [payDetailIndex, setPayDetailIndex] = React.useState(null); // เปิด popup ค่างวด

  const move = (i, dir)=>{
    const j = i+dir;
    if(j<0 || j>=banks.length) return;
    const next = banks.slice();
    const tmp = next[i]; next[i]=next[j]; next[j]=tmp;
    setBanks(next);
  };
  const updateBank = (i, patch)=> setBanks(prev=> prev.map((b,idx)=> idx===i? patch: b));
  const removeBank = (i)=> setBanks(prev=> prev.filter((_,idx)=> idx!==i));
  const addBank = ()=> setBanks(prev=> [...prev, {
    id: genId(), name: `ธนาคาร ${prev.length+1}`,
    principal: prev[0]?.principal || 1000000,
    termYears: prev[0]?.termYears || 20,
    rate1: 3.50, rate2: 3.80, rate3: 4.20, rateAfter: 6.25,
    monthlyOverride: null, prepayPct: 0, refiPref: "default",
    includeMrtaInLoan:false, mrtaRefund3yPct:60, mrtaRefund5yPct:40,
    otherCosts:{ MRTA:0,"ค่าประเมิน":0,"ค่าจดจำนอง":0,"ค่าธรรมเนียม":0,"ค่าปรับปิดก่อน":0 }
  }]);

  return (
    <div className="max-w-6xl mx-auto p-4 space-y-4">
      <div className="text-2xl font-semibold">ตัวช่วยเทียบรีไฟแนนซ์บ้าน</div>

      {/* แถบควบคุมหลัก */}
      <div className="controls-card">
        <div className="flex flex-wrap items-center gap-3">
          <L label="พฤติกรรมรีไฟแนนซ์ (ทั้งหมด)">
            <select className="ipt" value={refinanceBehavior} onChange={(e)=>setRefinanceBehavior(e.target.value)}>
              <option value="none">ไม่รีไฟแนนซ์</option>
              <option value="every3y">รีทุก 3 ปี</option>
              <option value="every5y">รีทุก 5 ปี</option>
            </select>
          </L>
          <div className="ml-auto flex items-center gap-2">
            <button className="btn" onClick={addBank}>+ เพิ่มธนาคาร</button>
          </div>
        </div>
        <div className="text-xs text-gray-600 mt-2">
          หมายเหตุ: รีไฟแนนซ์จะ <b>ไม่รีเซ็ตเป็น 30 ปี</b> แต่ใช้ <b>อายุคงเหลือจริง</b> ของสัญญาในแต่ละรอบ และจะ <b>หยุดรี</b> เมื่อหนี้คงเหลือ <b>&lt; 1,000,000</b> บาท
        </div>
      </div>

      {/* ตัวแก้ไขรายธนาคาร */}
      {banks.map((b, i)=>(
        <BankEditor
          key={b.id}
          bank={b}
          onChange={(nb)=>updateBank(i, nb)}
          onRemove={()=>removeBank(i)}
          onMoveUp={()=>move(i,-1)}
          onMoveDown={()=>move(i,1)}
        />
      ))}

      {/* ตารางเปรียบเทียบหลัก + ปุ่ม “ดูรายละเอียดค่างวด” */}
      <CompareTable
        banks={banks}
        refinanceBehavior={refinanceBehavior}
        onOpenSchedule={(idx)=>setScheduleIndex(idx)}
        onOpenPayDetail={(idx)=>setPayDetailIndex(idx)}  // << onOpenPayDetail
        onToggleFocus={()=>setShowFocus(v=>!v)}
        showFocus={showFocus}
      />

      {/* Investment: จุดตัด “หนี้ไม่โปะ vs พอร์ต” — ใช้ธนาคารแถวแรกเป็นฐาน */}
      {banks[0] && (
        <InvestmentPanel bank={banks[0]} refinanceBehavior={refinanceBehavior} />
      )}

      {/* Modals */}
      {scheduleIndex!=null && banks[scheduleIndex] && (
        <div className="focus-layer" onClick={()=>setScheduleIndex(null)}>
          <div className="focus-box" onClick={(e)=>e.stopPropagation()}>
            <div className="focus-head">
              <div className="font-semibold">ตารางผ่อน (งวด): {banks[scheduleIndex].name}</div>
              <button className="focus-close" onClick={()=>setScheduleIndex(null)}>✕ ปิด</button>
            </div>
            <div className="focus-body">
              <ScheduleView bank={banks[scheduleIndex]} refinanceBehavior={refinanceBehavior}/>
            </div>
          </div>
        </div>
      )}

      {payDetailIndex!=null && banks[payDetailIndex] && (
        <PayDetailPopup
          bank={banks[payDetailIndex]}
          refinanceBehavior={refinanceBehavior}
          onClose={()=>setPayDetailIndex(null)}
        />
      )}
    </div>
  );
}

/* ===================== Mount App ===================== */
const rootEl = document.getElementById("root");
if(rootEl){
  const root = ReactDOM.createRoot(rootEl);
  root.render(<App />);
}
