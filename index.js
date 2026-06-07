const { Client, GatewayIntentBits } = require('discord.js');
const { joinVoiceChannel, getVoiceConnection, createAudioPlayer, NoSubscriberBehavior, VoiceConnectionStatus } = require('@discordjs/voice');
const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config();

const PREFIX = '_';
const DATA_DIR = path.join(__dirname, 'data');
const DATA_JSON_FILE = path.join(DATA_DIR, 'data.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent, GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMembers
    ]
});

// Chỉ lưu session trong memory (không lưu file để tránh xung đột trạng thái)
const sessions = new Map();

client.once('ready', () => {
    console.log(`✅ Bot đã sẵn sàng: ${client.user.tag}`);
});

// --- LOGIC VOICE ---

client.on('voiceStateUpdate', async (oldState, newState) => {
    try {
        const sess = sessions.get(newState.guild.id);
        
        // Trường hợp bot tự out phòng hoặc bị kick → Tự động dọn dẹp session
        if (oldState.member?.id === client.user.id && oldState.channelId && !newState.channelId) {
            if (sess) {
                console.log(`⚠️ Bot bị ngắt kết nối voice đột ngột! Đang tự động dọn dẹp phiên.`);
                sessions.delete(newState.guild.id);
            }
            return;
        }

        if (!sess) return;
        const trackedChannelId = sess.voiceChannelId;

        // Khởi tạo user lần đầu vào tracked channel
        if (newState.channelId === trackedChannelId && !sess.members.has(newState.id)) {
            const isMuted = newState.selfMute === true;
            sess.members.set(newState.id, {
                hoTen: newState.member.displayName,
                muteCount: isMuted ? 0 : 1,
                commentCount: 0,
                totalMicSeconds: 0,
                unmuteStartTime: isMuted ? null : Date.now(),
                lastMuteState: isMuted
            });
            console.log(`➕ ${newState.member.displayName} vào tracked channel`);
            return;
        }

        const user = sess.members.get(newState.id);
        if (!user) return;

        // Rời khỏi tracked channel → cộng dồn mic time
        if (oldState.channelId === trackedChannelId && newState.channelId !== trackedChannelId) {
            if (user.unmuteStartTime !== null && user.unmuteStartTime !== undefined) {
                user.totalMicSeconds += Math.floor((Date.now() - user.unmuteStartTime) / 1000);
                user.unmuteStartTime = null;
            }
            user.lastMuteState = newState.selfMute === true;
            console.log(`➖ ${user.hoTen} rời khỏi channel`);
        }
        // Vào lại tracked channel
        else if (oldState.channelId !== trackedChannelId && newState.channelId === trackedChannelId) {
            const nowMuted = newState.selfMute === true;
            const wasMuted = user.lastMuteState === true;
            if (wasMuted && !nowMuted) {
                user.muteCount++;
                user.unmuteStartTime = Date.now();
            } else if (!nowMuted) {
                user.unmuteStartTime = Date.now();
            }
            user.lastMuteState = nowMuted;
        }

        // Theo dõi mute/unmute trong channel
        if (newState.channelId === trackedChannelId) {
            const nowMuted = newState.selfMute === true;
            const wasMuted = user.lastMuteState === true;

            // Từ unmute → mute: cộng dồn thời gian mic
            if (!wasMuted && nowMuted && user.unmuteStartTime !== null) {
                user.totalMicSeconds += Math.floor((Date.now() - user.unmuteStartTime) / 1000);
                user.unmuteStartTime = null;
            }
            // Từ mute → unmute: bắt đầu track mic
            else if (wasMuted && !nowMuted) {
                user.muteCount++;
                user.unmuteStartTime = Date.now();
            }

            user.lastMuteState = nowMuted;
        }
    } catch (err) {
        console.error('❌ Lỗi voiceStateUpdate:', err);
    }
});

// --- LỆNH ---

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (!message.guild) return;

    // Đếm tin nhắn nếu session đang chạy
    if (!message.content.startsWith(PREFIX)) {
        const sess = sessions.get(message.guild.id);
        if (sess && sess.members.has(message.author.id)) {
            sess.members.get(message.author.id).commentCount += 1;
        }
        return;
    }

    const [command] = message.content.slice(PREFIX.length).trim().split(/\s+/);

    // ===== LỆNH THAMGIA =====
    if (command === 'thamgia') {
        try {
            // Sửa lỗi kẹt session ảo: Nếu có session cũ nhưng thực tế bot không ở trong voice channel nào
            const existingConn = getVoiceConnection(message.guild.id);
            if (sessions.has(message.guild.id) && !existingConn) {
                sessions.delete(message.guild.id);
            }

            if (sessions.has(message.guild.id)) {
                return await message.reply('⚠️ Phiên đang chạy! Gõ `_thoat` để dừng.');
            }

            const vc = message.member.voice.channel;
            if (!vc) return await message.reply('❌ Bạn phải vào voice channel trước!');

            // Khởi tạo data cho tất cả members đang có mặt sẵn trong room
            const membersMap = new Map();
            const now = Date.now();
            
            vc.members.forEach(m => {
                const isMuted = m.voice.selfMute === true;
                membersMap.set(m.id, {
                    hoTen: m.displayName,
                    muteCount: isMuted ? 0 : 1,
                    commentCount: 0,
                    totalMicSeconds: 0,
                    unmuteStartTime: isMuted ? null : now,
                    lastMuteState: isMuted
                });
            });

            // Tạo session trong memory
            sessions.set(message.guild.id, {
                startTime: now,
                voiceChannelId: vc.id,
                members: membersMap
            });
            
            // Bot join voice channel
            const connection = joinVoiceChannel({ 
                channelId: vc.id, 
                guildId: message.guild.id, 
                adapterCreator: message.guild.voiceAdapterCreator 
            });

            // Tạo audio player (để duy trì kết nối voice ổn định)
            const player = createAudioPlayer({
                behaviors: { noSubscriber: NoSubscriberBehavior.Pause }
            });
            connection.subscribe(player);

            connection.on(VoiceConnectionStatus.Ready, () => {
                console.log(`✅ Bot vào voice thành công: ${vc.name}`);
            });

            connection.on(VoiceConnectionStatus.Disconnected, async () => {
                console.log(`⚠️ Bot bị ngắt kết nối tạm thời từ phòng ${vc.name}`);
                try {
                    await connection.rejoin();
                } catch (err) {
                    console.error(`❌ Tự động kết nối lại thất bại:`, err);
                    sessions.delete(message.guild.id);
                }
            });

            await message.reply(`✅ Bot vào **${vc.name}** - Đang ghi nhận dữ liệu!\nGõ \`_thoat\` để kết thúc và xuất báo cáo.`);
        } catch (err) {
            console.error('❌ Lỗi _thamgia:', err);
            sessions.delete(message.guild.id);
            await message.reply('❌ Lỗi khởi động phiên!');
        }
    }

    // ===== LỆNH THOAT =====
    if (command === 'thoat' || command === 'leave') {
        try {
            const sess = sessions.get(message.guild.id);
            if (!sess) return await message.reply('❌ Không có phiên đang chạy!');

            // Đọc data.json để lấy thông tin sinh viên
            let studentData = [];
            try {
                if (fs.existsSync(DATA_JSON_FILE)) {
                    studentData = JSON.parse(fs.readFileSync(DATA_JSON_FILE, 'utf8'));
                }
            } catch (e) { console.error('Lỗi đọc data.json:', e); }

            // Tạo báo cáo dữ liệu
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const outputPath = path.join(DATA_DIR, `report_${timestamp}.json`);

            const finalData = [];
            let sttCounter = 1;

            sess.members.forEach((data, uid) => {
                const info = studentData.find(s => s.UID === uid) || {};
                let totalMicSeconds = data.totalMicSeconds;
                
                // Nếu user vẫn đang unmute lúc gõ lệnh -> cộng nốt thời gian thực tế
                if (data.unmuteStartTime !== null && data.unmuteStartTime !== undefined) {
                    totalMicSeconds += Math.floor((Date.now() - data.unmuteStartTime) / 1000);
                }

                finalData.push({
                    STT: sttCounter++,
                    UID: uid,
                    "Mã số sinh viên": info["Mã số sinh viên"] || "N/A",
                    "Họ và tên": info["Họ và tên"] || data.hoTen,
                    "Vai trò": info["Vai trò"] || "Khách",
                    "Thời gian phát biểu (giây)": totalMicSeconds,
                    "Số lần mute/unmute": data.muteCount,
                    "Số tin nhắn": data.commentCount
                });
            });

            // Lưu file báo cáo
            fs.writeFileSync(outputPath, JSON.stringify(finalData, null, 2));

            await message.reply(`✅ Báo cáo đã lưu: \`${path.basename(outputPath)}\``);

            // 🛠️ GIẢI PHÁP SỬA LỖI TREO VOICE: Lấy connection TRƯỚC KHI xóa session trong Map
            const conn = getVoiceConnection(message.guild.id);
            sessions.delete(message.guild.id);

            if (conn) {
                try {
                    const subscription = conn.state.subscription;
                    if (subscription) subscription.unsubscribe();
                    if (subscription?.player) subscription.player.stop(true);
                    
                    conn.destroy(); // Out phòng ngay lập tức
                    // console.log(`✅ 🔌 Bot đã thoát khỏi voice thành công!`);
                } catch (err) {
                    console.error('⚠️ Lỗi khi đóng connection:', err);
                }
            } else {
                console.log(`⚠️ Không tìm được connection để disconnect chủ động.`);
            }

        } catch (err) {
            console.error('❌ Lỗi _thoat:', err);
            await message.reply('❌ Lỗi xuất báo cáo!');
            
            // Force cleanup khẩn cấp nếu crash dữ liệu
            try {
                const conn = getVoiceConnection(message.guild.id);
                if (conn) conn.destroy();
                sessions.delete(message.guild.id);
            } catch (e) { }
        }
    }

    // ===== LỆNH DIEMDANH =====
    if (command === 'diemdanh') {
        try {
            const vc = message.member.voice.channel;
            if (!vc) return message.reply('❌ Bạn phải vào voice channel để sử dụng lệnh này!');

            // Đọc dữ liệu học sinh từ file json để map thông tin đầy đủ
            let studentData = [];
            try {
                if (fs.existsSync(DATA_JSON_FILE)) {
                    studentData = JSON.parse(fs.readFileSync(DATA_JSON_FILE, 'utf8'));
                }
            } catch (e) { console.error('Lỗi đọc data.json:', e); }

            const danhSach = [];
            let sttCounter = 1;

            vc.members.forEach(m => {
                const info = studentData.find(s => s.UID === m.id) || {};
                danhSach.push({
                    STT: sttCounter++,
                    UID: m.id,
                    "Mã số sinh viên": info["Mã số sinh viên"] || "N/A",
                    "Họ và tên": info["Họ và tên"] || m.displayName,
                    "Vai trò": info["Vai trò"] || "Khách"
                });
            });

            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const fileName = `diemdanh_${timestamp}.json`;
            const filePath = path.join(DATA_DIR, fileName);

            fs.writeFileSync(filePath, JSON.stringify(danhSach, null, 2));
            await message.reply(`✅ Lưu danh sách điểm danh thành công: \`${fileName}\` (Tổng số: ${danhSach.length} thành viên)`);
        } catch (err) {
            console.error('❌ Lỗi _diemdanh:', err);
            await message.reply('❌ Lỗi lưu danh sách điểm danh!');
        }
    }

    // ===== LỆNH STATUS =====
    if (command === 'status') {
        const sess = sessions.get(message.guild.id);
        if (!sess) return message.reply('❌ Không có phiên học nào đang chạy trên máy chủ này.');
        
        const uptime = Math.floor((Date.now() - sess.startTime) / 1000);
        const minutes = Math.floor(uptime / 60);
        const seconds = uptime % 60;
        
        const memberData = Array.from(sess.members.values());
        const totalMicTime = memberData.reduce((sum, m) => {
            let time = m.totalMicSeconds;
            if (m.unmuteStartTime !== null) {
                time += Math.floor((Date.now() - m.unmuteStartTime) / 1000);
            }
            return sum + time;
        }, 0);

        message.reply(`
📊 **Trạng thái phiên học hiện tại:**
• Số lượng thành viên theo dõi: ${sess.members.size}
• Tổng thời gian lớp học diễn ra: ${minutes}m ${seconds}s
• Tổng thời gian phát biểu của lớp: ${Math.floor(totalMicTime / 60)}m ${totalMicTime % 60}s
• Trạng thái hoạt động: Tốt ✅
        `);
    }

    // ===== LỆNH FORCEXIT (ADMIN) =====
    if (command === 'forcexit') {
        try {
            if (!message.member.permissions.has('Administrator')) {
                return message.reply('❌ Lệnh này yêu cầu quyền Quản trị viên (Administrator)!');
            }

            const sess = sessions.get(message.guild.id);
            if (!sess) return message.reply('❌ Không tìm thấy phiên nào đang chạy.');

            let studentData = [];
            try {
                if (fs.existsSync(DATA_JSON_FILE)) {
                    studentData = JSON.parse(fs.readFileSync(DATA_JSON_FILE, 'utf8'));
                }
            } catch (e) { }

            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const outputPath = path.join(DATA_DIR, `report_${timestamp}.json`);

            const finalData = [];
            let sttCounter = 1;

            sess.members.forEach((data, uid) => {
                const info = studentData.find(s => s.UID === uid) || {};
                let totalMicSeconds = data.totalMicSeconds;
                if (data.unmuteStartTime !== null && data.unmuteStartTime !== undefined) {
                    totalMicSeconds += Math.floor((Date.now() - data.unmuteStartTime) / 1000);
                }

                finalData.push({
                    STT: sttCounter++,
                    UID: uid,
                    "Mã số sinh viên": info["Mã số sinh viên"] || "N/A",
                    "Họ và tên": info["Họ và tên"] || data.hoTen,
                    "Vai trò": info["Vai trò"] || "Khách",
                    "Thời gian phát biểu (giây)": totalMicSeconds,
                    "Số lần mute/unmute": data.muteCount,
                    "Số tin nhắn": data.commentCount
                });
            });

            fs.writeFileSync(outputPath, JSON.stringify(finalData, null, 2));
            await message.reply(`✅ Đã kích hoạt cưỡng chế đóng phiên! Báo cáo: \`${path.basename(outputPath)}\``);

            // Đưa việc lấy connection lên đầu, dọn dẹp và đóng phòng lập tức
            const conn = getVoiceConnection(message.guild.id);
            sessions.delete(message.guild.id);

            if (conn) {
                try {
                    const subscription = conn.state.subscription;
                    if (subscription) subscription.unsubscribe();
                    if (subscription?.player) subscription.player.stop(true);
                    
                    conn.destroy();
                    console.log(`✅ 🔌 Force exit thành công!`);
                } catch (err) {
                    console.error('⚠️ Lỗi khi đóng connection cưỡng chế:', err);
                }
            }
        } catch (err) {
            console.error('❌ Lỗi _forcexit:', err);
            await message.reply('❌ Có lỗi nghiêm trọng xảy ra khi thực hiện Force Exit!');
            
            try {
                const conn = getVoiceConnection(message.guild.id);
                if (conn) conn.destroy();
                sessions.delete(message.guild.id);
            } catch (e) { }
        }
    }
});

// Quản lý và theo dõi lỗi hệ thống toàn cục nhằm tránh crash bot đột ngột
client.on('error', err => console.error('❌ Lỗi từ Client Discord:', err));
process.on('unhandledRejection', err => console.error('❌ Lỗi Unhandled Rejection (Bất đồng bộ):', err));

client.login(process.env.DISCORD_TOKEN);