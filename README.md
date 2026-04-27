# Leviathan

## ☁️ Debrid Saved Cloud

<div align="center">

---

<h3>☁️ Debrid Saved Cloud</h3>
<p><strong>RD/TorBox cloud-aware · opzionale · zero duplicati</strong></p>

</div>

<div style="border:1px solid #2f3b52; border-radius:14px; padding:20px; margin:18px 0;">

Il **Debrid Saved Cloud** è un layer opzionale che permette a Leviathan di riconoscere i file già salvati nel cloud personale dell’utente su **Real-Debrid** e **TorBox** e integrarli nella lista stream in modo pulito e coerente.

La pipeline principale **non cambia**: Leviathan continua prima a cercare torrent, cache, provider esterni e risultati web. Solo dopo questo passaggio controlla anche il cloud personale dell’utente e prova a capire se esistono file già presenti che corrispondono davvero al contenuto richiesto.

### Cosa fa

- supporta **solo Real-Debrid e TorBox**;
- è **opzionale** e si attiva dal configuratore desktop e da `smartphone.js`;
- funziona con modalità **smart**, **fallback** e **always**;
- usa match su **titolo, anno, stagione, episodio, anime/episodio assoluto** e filtri lingua/qualità;
- **non crea duplicati**: lo stesso hash non viene mai mostrato due volte;
- se un torrent normale è anche presente nel cloud, Leviathan **non aggiunge una copia**, ma **annota lo stream già esistente** come cloud salvato;
- usa route dedicate di playback:
  - `/play_saved_cloud/rd/...`
  - `/play_saved_cloud/tb/...`
- non cancella torrent o file del cloud dell’utente.

### Modalità

- **smart** → controlla il cloud solo quando ha senso, senza appesantire la pipeline;
- **fallback** → controlla il cloud solo se i risultati normali sono pochi o insufficienti;
- **always** → controlla sempre il cloud, ma **i duplicati restano comunque esclusi**.

### Formatter

Gli stream cloud usano una resa visiva coerente con il formatter Leviathan:

- al posto del fulmine viene usata la **nuvola**;
- badge coerenti con gli altri stream;
- label chiara tipo **CLOUD SALVATO • RD** oppure **CLOUD SALVATO • TB**;
- se uno stream già presente corrisponde a un file del cloud, viene semplicemente **marcato** come cloud salvato.

### Debug

Per il debug Leviathan espone log dedicati con prefisso:

- `[SAVED CLOUD] gate`
- `[SAVED CLOUD] lookup start`
- `[SAVED CLOUD] RD/TB scan start`
- `[SAVED CLOUD] duplicate upgrade`
- `[SAVED CLOUD] added=...`

Questi log servono a capire subito se il layer è attivo, se il cloud è stato controllato, se un file è stato scartato come duplicato oppure se uno stream esistente è stato correttamente annotato come **Cloud Salvato**.

### Risultato finale

Il risultato è un comportamento molto semplice da capire:

- se nel cloud esiste un file utile e **non è già presente**, Leviathan lo aggiunge;
- se nel cloud esiste ma Leviathan ha già trovato lo stesso hash, **non duplica nulla**;
- se il file cloud coincide con uno stream già mostrato, Leviathan **lo evidenzia** come **Cloud Salvato**.

In questo modo l’utente ottiene un’integrazione cloud reale, leggibile e utile, senza sporcare la lista stream con copie inutili.

</div>
