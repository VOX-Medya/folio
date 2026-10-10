# Veri sözleşmesi: eser, hak, kullanıcı ve operasyon

## Kanonik katalog
- authors(id uuid PK, canonical_name, sort_name, born_at, died_at, biography, status); author_aliases(id,author_id,name,locale), author_external_ids(source,external_id,author_id).
- works(id uuid PK, original_title, original_language, first_publication_year, description, publication_status); work_authors(work_id,author_id,contribution,sort_order) M:N; work_titles(work_id,language,title,kind); work_genres/work_tags.
- editions(id uuid,work_id,language,publisher,published_at,translator_id nullable,identifiers,source_notes). Çok yazarlı/çevirmenli eser için contributor join, özgün içerik ile tercüme ayrımı.
- source_provenance(id,source_name,source_url,source_external_id,license_claim,original_metadata_snapshot,import_batch_id,reviewer_id). V1 manual_local_pkg kimliği; gelecek kaynağa özel otomasyon yok.
- content_revisions(id uuid,edition_id,language,parent_revision_id,source_revision_id,normalized_hash,raw_hash,parser_version,status,immutable_created_at,created_by); content_chapters(revision_id,id,ordinal,heading); content_blocks(revision_id,block_uuid,chapter_id,parent_id,ordinal,kind,source_locator,text_hash,source_text,flags_normal,flags_rsvp,flags_audio). Orijinal kaynak blob değişmez; düzeltmeler yeni revizyon ve onay.
- text_alignments(source_rev_id,target_rev_id,source_block_id,target_block_id,kind,confidence,verified). 1→N/N→1 desteklenir; çevrilmemiş metin için yaklaşık konum göster, yanlış blok eşlemesi yapma.
- media_assets(id uuid,owner_scope,owner_user_id nullable,storage_key,sha256,size,mime,revision_id optional,rights_record_id,created_at); audio_variants(id,content_revision_id,language,voice_id,provider_label,model_version,codec,metadata,status); audio_segments(variant_id,chapter_id,ordinal,asset_id,text_hash,start_ms,end_ms,duration_ms,alignment_json optional).
- cover_templates(id,version,tokens,contrast); work_cover_settings(work_id,template_version,palette_id,title_override,subtitle_override); rendered covers asset ID, deterministic version.

## Telif
- rights_records(id,work_id,edition_id,revision_id,source_url,evidence,license_kind,territories,display_allowed,translation_allowed,audio_allowed,sharing_allowed,review_status,reviewed_by,reviewed_at,expiry).
- Rights yanlışsa display/translation/audio/public visibility için işlem veto; çevrilmiş eser veya belirli baskının telif durumu özgün eserden ayrıdır. Kullanıcıya özel upload genel katalog transferinde kaybolmadan hariç tutulur.
- Publicly accessible source != globally distributable permission. Ülke filtrelemesi, access token ve CDN/cache iptaline yansıtılır.

## Kullanıcılar, oturum, konum
- users, accounts, sessions, devices, verified_emails, admin_roles/permissions/MFA, user_preferences(locale/theme/reader typography/RSVP settings/privacy).
- onboarding_progress(user_id,flow_version,step,status,updated_at); job_requests(user_id,job_kind,request_status,asset_scope,created_at) V1 sadece dosya yükleme/manuel üretim isteklerini belgeleyen lifecycle; otomatik TTS sistemi YOK.
- user_library(user_id,work_id,edition_id,collection,shelf,state,added_at), reading_progress(user_id,content_revision_id,chapter_id,block_uuid,token_offset,source_locator,progress_percent,last_mode,last_active_at,server_revision), reading_sessions(mode,device_id,started_at,ended_at,active_seconds,words_completed,event_source). Geçmiş navigasyon/süre ayrıca.
- player_progress(user_id,audio_variant_id,segment_id,position_ms,last_play_speed), reader_bookmarks(user_id,content_revision_id,block_uuid,offset), highlights(notes anchors,privacy), notes, collections, goals, streak_snapshots, daily_reading_stats, event_aggregates.
- reading_progress boyut/cihaz/cross-language değişse bile kalıcı semantik blok konumu; aynı sürüme bağımlı anchor kırılmasın diye blok haritalama/redirect. Translation switch hizalama 1-N, belirsizse bölüm başlangıcı + kullanıcı uyarısı. Ses saniye konumu kaynak blokla eşleştirilir, eksikse en yakın bölüm.
- Offline write: client_op_id + monoton revision, idempotent işleme, cihaz zamanı tek otorite değil; kullanıcı bilinçli geri sararsa max(percent) seçme. Conflict politikası açık testlerle kararlaştırılacak.

## Sosyal
- friend_invites(issuer_id,opaque_code_hash,expires_at,uses/status), friend_requests(from_user_id,to_user_id,invite_id,state), friendships(user1_id,user2_id,since), user_blocks.
- friends invite code/QR/deep link + karşılıklı kabul; başka kişiyi kullanıcı adıyla veya telefon/e-posta ile arama, public index veya friend suggestions API YOK.
- profile_visibility(user_id,profile_type public/private, shelves_visibility, progress_visibility, wpm_visibility, stats_visibility, friends_visibility, activity_visibility).
- reviews(work_id/user_id,content,stars,created/status), review_comments, feed_events, reports, moderation_actions; yayın tarihi; kötüye kullanım ve engelleme kuralları.

## İş/taşınabilirlik
- import_batches(id,package_id,schema_version,checksum,status,dry_run,actor_id,created_at,applied_at), import_items(batch_id,external_work_key,matched_work_id,operation,conflict,validation), export_batches(id,scope,created_by,hash,manifest_ref).
- audit_events(actor_id,action,entity_id,before_json,after_json,reason,request_id,ip,at), admin_permissions, platform_flags, notification_inbox, security_events.
- Storage provider registry: disk başlangıç implementasyonu; gelecekte S3 / remote adapter, provider_id/ver metadata ve üretim geçmişi kolonları tutulur; user-visible üretim UI'sı V1'de aktive edilmez.

## Veri bütünlüğü
- Tüm API yazımlarında input schema/constraint ve transaction.
- Tekilleştirme: raw sha256 + normalized hash + bibliyografik matching + insan onayı; title/ISBN tek benzersiz anahtar OLAMAZ.
- Global asset dedup **yalnız lisans/owner_scope aynı hak paylaşımına izin veriyorsa**.
- İçerik revizyonu yayımlandıktan sonra immutable; yeni revizyon eski kullanıcının ilerlemesini otomatik silmez, anchor migration ve diff raporu gerekir.
- Hard delete yerine archive/withdrawal, GDPR/KVKK kapsamındaki silmelerin kapsamı ayrıca yönetilir.
- Metin blok türleri: paragraph, heading, footnote, page_number, running_header, publisher_note, preface, endnote, poetry, quote, list, image_ref; normal/RSVP/audio seçimleri bağımsız.
- DB migration testleri: up, fresh init, audit history, rollback strategy (destructive migration yok), seed fixture; yeterli index (work_id, revision_id, user_id, last_active_at) ve arama (Postgres full-text / pg_trgm).

## Kodlanan ilk kanonik ilişkiler
`packages/db/src/schema.ts` ve `docs/13-CANONICAL-CATALOG.md`, yazar takma adı/harici kimlik, eserin çoklu başlığı, work_author N:M, baskı/çeviri kimliği, baskıya bağlı ISBN ve editör/çevirmen ilişkilerinin ilk şemasını içerir. Bu aşamada kayıtlar yalnız draft; telif onaysız yayın ve public API yoktur.
