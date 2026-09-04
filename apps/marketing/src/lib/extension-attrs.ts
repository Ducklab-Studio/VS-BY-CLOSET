/**
 * Script que roda antes da hidratação para remover atributos injetados por
 * extensões de navegador.
 *
 * O Bitdefender (TrafficLight) carimba `bis_skin_checked="1"` em todo <div>
 * do DOM assim que o HTML é analisado — antes do React hidratar. O React
 * então compara o DOM que encontra com o que ele mesmo renderiza, vê um
 * atributo que nunca emitiu, e dispara o aviso de hydration mismatch em todo
 * <div> da página.
 *
 * `suppressHydrationWarning` no <body> não resolve: ele só vale um nível de
 * profundidade — cobre o próprio <body>, não os <div> descendentes. E não dá
 * pra espalhar o atributo por todo <div> porque boa parte deles é interna
 * (Next.js, R3F) e porque isso passaria a mascarar mismatches de verdade.
 *
 * A saída é limpar o DOM na janela em que isso importa. O script roda como
 * primeiro filho do <body>, ou seja, de forma síncrona durante a análise do
 * HTML: varre o que já existe e instala um MutationObserver que remove os
 * atributos conforme a extensão os adiciona. O observer é desligado assim que
 * a hidratação termina (ver ExtensionAttrGuard) — depois disso o React não
 * revalida mais nada, os atributos ficam inofensivos, e não faz sentido
 * seguir disputando o DOM com a extensão pelo resto da vida da página.
 */
const ATTRS = ['bis_skin_checked', 'bis_register', '__bis_id'];

/** Nome global usado pelo ExtensionAttrGuard pra desligar o observer. */
export const STOP_SCRUB_FN = '__vsStopAttrScrub';

export const EXTENSION_ATTR_SCRIPT = `(function(){
var A=${JSON.stringify(ATTRS)};
var S=A.map(function(a){return '['+a+']'}).join(',');
function scrub(el){
  if(!el||el.nodeType!==1)return;
  for(var i=0;i<A.length;i++)if(el.hasAttribute(A[i]))el.removeAttribute(A[i]);
  var h=el.querySelectorAll(S);
  for(var j=0;j<h.length;j++)for(var k=0;k<A.length;k++)h[j].removeAttribute(A[k]);
}
scrub(document.documentElement);
var o=new MutationObserver(function(recs){
  for(var i=0;i<recs.length;i++){
    var r=recs[i];
    if(r.type==='attributes'){r.target.removeAttribute(r.attributeName)}
    else{for(var j=0;j<r.addedNodes.length;j++)scrub(r.addedNodes[j])}
  }
});
o.observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:A});
window.${STOP_SCRUB_FN}=function(){o.disconnect()};
})();`;
