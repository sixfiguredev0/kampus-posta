import { ArrowRight, BellRing, Inbox, LockKeyhole, Smartphone, Star, Tags } from 'lucide-react';

export const metadata = {
  title: 'Кампус Поща · пощата на ТУ – София, подредена',
  description: 'Бърз уеб клиент за университетската поща на ТУ – София, с известия на телефона. Чете и изпраща директно през сървърите на ТУ.',
};

// Fictional rows for the static preview; no real mail is ever shown on this page.
const previewRows = [
  ['УО', 'Учебен отдел', 'График за зимната изпитна сесия', '10:52', true, 'Учебни', 'blue'],
  ['ФС', 'Факултетен съвет', 'Записване за избираеми дисциплини', '10:48', true, 'Администрация', 'amber'],
  ['БТ', 'Библиотека ТУ', 'Книги за връщане тази седмица', 'вчера', false, null, null],
  ['СС', 'Студентски съвет', 'Среща на студентските клубове', '17 ноем.', false, 'Събития', 'green'],
];

const facts = [
  [LockKeyhole, 'Директно към ТУ', 'Влизането и пощата минават само през сървърите на tu-sofia.bg (IMAPS 993 и SMTP 27). Писмата ви не се копират другаде.'],
  [Tags, 'Подредена поща', 'Звезди, етикети, архив и кошче. Избирате много писма наведнъж, а преместването може да се отмени.'],
  [Smartphone, 'Удобна на телефон', 'Списъкът и писмото се сменят плавно, а бутонът „Назад“ ви връща точно там, където бяхте. Добавете я към началния екран като приложение.'],
  [BellRing, 'Известия на телефона', 'Ново писмо във Входящи идва като известие с подателя и темата, без приложението да е отворено. Почти не харчи батерия. На iPhone първо я добавете към началния екран.'],
];

export default function Home() {
  return <div className="home">
    <div className="aurora home-aurora" aria-hidden="true"><i /></div>
    <header className="home-top">
      <a className="brand" href="/" aria-label="Кампус Поща – начало">
        <img className="brand-mark" src="/logo.png" alt="" width={36} height={36} />
        <span className="brand-name">Кампус <strong>Поща</strong></span>
      </a>
      <a className="quiet-button home-signin" href="/mail">Влез</a>
    </header>

    <main>
      <section className="home-hero">
        <div className="home-copy">
          <h1>Университетската ви поща, подредена и бърза.</h1>
          <p>Кампус Поща е уеб клиент за имейла ви в ТУ – София. Четете, отговаряте и подреждате писмата си от компютър или телефон, а за новите писма получавате известие на телефона.</p>
          <div className="home-cta">
            <a className="primary" href="/mail">Влез с пощата на ТУ <ArrowRight size={17} /></a>
            <a className="quiet-button" href="#data">Какво се пази</a>
          </div>
        </div>
        <div className="home-preview" aria-hidden="true">
          <div className="home-notice"><img src="/logo.png" alt="" width={34} height={34} /><span><b>Учебен отдел</b><span>График за зимната изпитна сесия</span></span><time>сега</time></div>
          <div className="home-preview-head"><Inbox size={16} /><strong>Входящи</strong><span>2 непрочетени</span></div>
          {previewRows.map(([initials, sender, subject, time, unread, label, color], index) =>
            <div className={'home-preview-row' + (unread ? ' unread' : '') + (index === 0 ? ' selected' : '')} key={subject}>
              <span className={'avatar avatar-' + index}>{initials}</span>
              <span className="home-preview-text"><b>{sender}</b><span>{subject}</span>
                {label && <span className={'label-chip chip-' + color}>{label}</span>}</span>
              <span className="home-preview-meta"><time>{time}</time>{index === 1 ? <Star size={14} fill="currentColor" /> : unread && <i className="unread-dot" />}</span>
            </div>)}
        </div>
      </section>

      <section className="home-facts">
        {facts.map(([Icon, title, text]) => <div className="home-fact" key={title}>
          <span className="home-fact-icon"><Icon size={20} /></span>
          <h2>{title}</h2>
          <p>{text}</p>
        </div>)}
      </section>

      <section className="home-data" id="data">
        <h2>Какво се пази и колко време</h2>
        <dl>
          <div><dt>Писмата ви</dt><dd>Не се копират. Всяко писмо се отваря от сървъра на ТУ, когато го четете.</dd></div>
          <div><dt>Сесията</dt><dd>Имейлът и паролата се пазят криптирани (AES-256-GCM), докато сте влезли. Изтриват се при „Изход“, след 24 часа без активност или най-късно след 7 дни.</dd></div>
          <div><dt>Етикети и чернова</dt><dd>Вашите етикети и една незавършена чернова. Достъпни са само за вашия профил.</dd></div>
          <div><dt>Файлове за изпращане</dt><dd>Пазят се до изпращането и най-много 1 ден.</dd></div>
          <div><dt>Известия</dt><dd>Докато са включени, данните за вход в TU се пазят криптирани с ключ, който има само сървърът за известия. Изтриват се, когато изключите известията или излезете от това устройство, и най-късно след 90 дни без вход. До телефона стигат само подателят и темата.</dd></div>
          <div><dt>Сървърът за известия</dt><dd>Следи само за нови писма във Входящи и не ги маркира като прочетени.</dd></div>
          <div><dt>Статус „прочетено“</dt><dd>Отвореното писмо се маркира като прочетено и в TUSmail. Можете да изключите това от настройките.</dd></div>
        </dl>
      </section>
    </main>

    <footer className="home-footer">
      <p>Кампус Поща не е официална услуга на ТУ – София. Официалната поща е на <a href="https://tusmail.tu-sofia.bg/" target="_blank" rel="noreferrer">tusmail.tu-sofia.bg</a>.</p>
    </footer>
  </div>;
}
