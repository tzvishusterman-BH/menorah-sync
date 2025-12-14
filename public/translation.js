const translations = {
  en:{ title:"Berlin Menorah Parade 5786", family:"Family Name", arm:"ARM AUDIO" },
  he:{ title:"תהלוכת מנורה ברלין 5786", family:"שם משפחה", arm:"הפעל שמע" },
  ru:{ title:"Парад Меноры Берлин 5786", family:"Фамилия", arm:"ВКЛЮЧИТЬ АУДИО" },
  de:{ title:"Menora-Parade Berlin 5786", family:"Familienname", arm:"AUDIO AKTIVIEREN" }
};

function apply(lang){
  document.querySelectorAll("[data-i18n]").forEach(el=>{
    el.textContent = translations[lang][el.dataset.i18n];
  });
}
