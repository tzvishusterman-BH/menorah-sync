//-------------------------------------------------------------
// MULTI-LANGUAGE TRANSLATIONS (Client + Admin)
// Languages: English, Hebrew (LTR), Russian, German
//-------------------------------------------------------------

const translations = {

  en: {
    // Client
    clientTitle: "Berlin Menorah Parade 5786",
    familyName: "Family Name",
    armBtn: "ARM AUDIO",
    pauseBtn: "PAUSE",
    playBtn: "PLAY",
    status: "Status",
    nowPlaying: "Now Playing",
    instructions: "If audio becomes unsynchronized, simply refresh the page.",

    // Admin
    adminTitle: "Admin — Berlin Menorah Parade 5786",
    enterPin: "Enter Admin PIN",
    enter: "Enter",
    playlist: "Playlist",
    add: "Add",
    nextOverride: "Next Track Override"
  },

  he: {
    clientTitle: "תהלוכת מנורה ברלין 5786",
    familyName: "שם משפחה",
    armBtn: "הפעל שמע",
    pauseBtn: "השהה",
    playBtn: "נגן",
    status: "סטטוס",
    nowPlaying: "מנגן כעת",
    instructions: "אם הסנכרון נפגם, נא לרענן את הדף.",

    adminTitle: "מנהל — תהלוכת מנורה ברלין 5786",
    enterPin: "הכנס קוד מנהל",
    enter: "כניסה",
    playlist: "רשימת השמעה",
    add: "הוסף",
    nextOverride: "עקיפת רצועה הבאה"
  },

  ru: {
    clientTitle: "Парад Меноры Берлин 5786",
    familyName: "Фамилия",
    armBtn: "ВКЛЮЧИТЬ АУДИО",
    pauseBtn: "ПАУЗА",
    playBtn: "ПУСК",
    status: "Статус",
    nowPlaying: "Сейчас играет",
    instructions: "Если аудио рассинхронизировано — перезагрузите страницу.",

    adminTitle: "Админ — Парад Меноры Берлин 5786",
    enterPin: "Введите PIN администратора",
    enter: "Войти",
    playlist: "Плейлист",
    add: "Добавить",
    nextOverride: "Следующая композиция"
  },

  de: {
    clientTitle: "Menora-Parade Berlin 5786",
    familyName: "Familienname",
    armBtn: "AUDIO AKTIVIEREN",
    pauseBtn: "PAUSE",
    playBtn: "PLAY",
    status: "Status",
    nowPlaying: "Aktueller Titel",
    instructions: "Falls die Synchronisierung abweicht, bitte die Seite neu laden.",

    adminTitle: "Admin — Menora-Parade Berlin 5786",
    enterPin: "Admin-PIN eingeben",
    enter: "Eingeben",
    playlist: "Playlist",
    add: "Hinzufügen",
    nextOverride: "Nächster Titel Override"
  }

};


// Apply translations to DOM
function applyTranslations(lang) {
  document.querySelectorAll("[data-i18n]").forEach(el => {
    const key = el.getAttribute("data-i18n");
    if (translations[lang] && translations[lang][key]) {
      el.textContent = translations[lang][key];
    }
  });

  // Handle placeholders
  document.querySelectorAll("[data-i18n-placeholder]").forEach(el => {
    const key = el.getAttribute("data-i18n-placeholder");
    if (translations[lang] && translations[lang][key]) {
      el.placeholder = translations[lang][key];
    }
  });
}
