import dotenv from 'dotenv'
import { ChatGPTAPI } from 'chatgpt'
import { Client, GatewayIntentBits, REST, Routes, Partials, ChannelType } from 'discord.js'

const MAX_RESPONSE_CHUNK_LENGTH = 1500
dotenv.config()

const commands = [
    {
        name: 'ask',
        description: 'Ask Anything!',
        options: [
            {
                name: "question",
                description: "Your question",
                type: 3,
                required: true
            }
        ]
    },
];

async function initChatGPT() {
    let sessionToken= "eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0..mWjhaq356WdFPY1M.gTyMe_JKMi9Y6DoKmoeC21boJrBeKUKV1uqvNAq2Xx6GNi2TD9RoBbP6XPHbWqVV6Z93z7L2aPqK9ub3e38WtGAAg02kF43Eq11sK3e-boO22E_Exq9_2arfFBni2R2QK03lp3NknKOiUfbCKLv0eFPTNiK4fizu0yjDWAROZ6B232PsD9w5PVCY-ZYVLEc_s6rcS73ZTRkzFrs12BRnoP-zEOdMGM4tK3AQiRcdTRmq9a5n_ZPyzhWulKeF6o8rFyRD6C2r08CxG7iA6Ik9MJNNhqgaaL4IzxcZcXy1eWh8v_KXH7SXN4RjRcD-aFFl3ll6nliIjmPMfDYhuVQReveW_Q1eCvoJZmoNT7u8CTtPiaLpaHAphzDkaDmb7cFYukZW63zpAMRAYCmJjxm4NZ4GJrzdr3UNyh94rxIR17auASkY3dDTsoVk57oUQ6mxvmKuLzLIvZdNMpzbThsICBSxqR463Iz2kxZy5SEzedEv9jv1qhG5osRlzIMzMsNVCu_obNvBlwQWm59IJ_c7IN1M1h2diRr2i8g81nopHGvY5iGwKdx38KjLQVGh5dgAU3hUs5j1EghstQ64DO8Hn8fM2Csec6negjJOkpvoXOE5RejvYqFEDWY4Dtr3frMYaADFpedWhlPaWEx4v71HL_2zLfa0OMPzsdn9q7FLAgj1EBFLuDJ2oMa49cbfe41FcQ7-OT64d9RsEQUYagALep6udHIa-_2_VJZtyNm2y6l51c1u0PXfetCn71oNpvcs4ddTxijRHZ6snYOEF8Br1dKixJcYw5jqPDZrXLrO3FzHQYcLS4wOUuA68muudUc5XfkLW46nzgFn_G2lBUhQZODg3tO_0FrfLNcB5hweXPwLaEFyHi0-e_4q6pjVupaD391klnoJXeNHZerKSnGlJIiLgxdYKDOn5L_TAbpUov5V-6EJ8nGFNBEAn2BX8LavB6MoLSLjiBgRelR6wX8YjBykn4WCyxmaUXH3g02mzxxILdy781PBU-rhF12pA8nHU5x7Ij8VPgTMAK9xFZI-j7Q5Fnd1DaN11XixUqRjCj_TpPSvjFEl7BKGXS03wsw3OF3WjtJceeL4P5V0SLh9IiomttI-cp-o3Mm2TJJQWRhM1Rup98_LqJk2Ouu53pwET-sKwf6VSyKikUBmGbILFZgaoOxq7j5CN25HP_wIMDouvHpc6X3PDrUukwwQIGUgG4XHj6ypAZk9yp_tzzDr_V4u4GQCkng9C378gr1j8aGsxEO_TkYSPWFZCg6UpMtQq8W_tsRhEwIgIQf8G6rF7aQbhkXohCNkBpBx3MhwPycQzdFDVVqydmH76KIzGbccwHQW0t5NJnFNJ5Li13pvPWMwLvlRON4_BoIXxU5HSHEiQ5MTUpASOLHc8RMc667LHKl9vj37qcby9e7kYOgpQj9CVKlsRZ5vWnGe2oywx6WqU2swNuKrEEd12ixwIuV77UrFGB2DGPtaGwY65INlBhaw5VXiOAseqGHqSS0twGvWHHF2XWR0utCGJYj00b0EocvGyNcCL4g7B59rpIIyFe1vxglcPgZzJ6qa8vNDG0ar9XIej4uRATOWRrTFwiepVo0-lPmD1DCUUvaN0KknKbY1oG8hAk-AXd2dIcZcgKIlNCYJMMuOxaIZ4kS-OqcqSsL8bK-kjTPSt-2FdddjP43GZlnp9mUHvXKjPqeei8UKBekDWfYOkusj7ULvWdEGC5djgVgZcLlwewGzCqvpDsvsipjqZEs1jFKiYNUgebQLT1agnkr7zM1rBnbs5t_Z5qG2pZyWYKjGyFe6aSIxIjgX79xxy6trTNYMoHn_eZ55BlmsU4sg-wxkKeBpsiEf7pMhIdDE8p3rZae-L05CFHj1Mo4OmRmYAAWGNSCNxwWpCTr8PPjCv_XnKvlT3s3YO1nTJOiu3xSOR9-56Zs8PRp3LORIXpDvzJiItqEHPyLbBRp677FqBpfiIkln_aXYX8IBjzmfD_6jVg-KjqCWuCiPfWbf9kKm-eGmoDmC4nR-uSOV3PsCzADXYCIZeo31Aw4YW4ENu8PjBUzCj2PcKo13JdCgPGM9hjA_vUVXXcVLhr1ZMwE9vFKhb7OHPtPawTwbQAQUWSmaRkbqtq_VPDLTebzBBv_J8K24RkpZgVkwu7o0S6UtXbGtFVtzhDz3y_mu_fEqA61XAI33rSr4hKpvBqBkOXEFE7DTrD1Y9onFpm4jAidsqyRNizx7qbsNyR-mQiAJIXG3RyEucUrWdrkp93n0w88jkcMgblxHPynJ0JQ1S29LuezK6par8j8oyzTUCaFfdKvsfuM1x6b8BVH7I0n2itBXDTR_2T7WArbpiBPBWUjIrZ6Not6C.vccq7zqK4RlYfmXQ0zgYjA"
    // let counter = 10;
    // while (counter>0) {
    //     try {
    //         sessionToken = await OPENAI_SESSION.getSession(process.env.OPENAI_EMAIL, process.env.OPENAI_PASSWORD)
    //         break
    //     } catch (e) {
    //         console.error("initChatGPT ERROR : " + e)
    //         counter--;
    //     }
    // }

    // if(counter==0){
    //     throw "Invalid Auth Info!"
    // }

    let api = new ChatGPTAPI({ sessionToken })

    await api.ensureAuth()

    // async function updateSessionToken(){
    //     try {
    //         let sessionToken = await OPENAI_SESSION.getSession(process.env.OPENAI_EMAIL, process.env.OPENAI_PASSWORD)
    //         let new_api = new ChatGPTAPI({ sessionToken })

    //         await new_api.ensureAuth()

    //         api = new_api
    //         console.log("Session Token Changed - ", new Date())
    //     } catch (e) {
    //         console.error(e)
    //     }finally{
    //         setTimeout(updateSessionToken,600000)
    //     }
    // }
    // setTimeout(updateSessionToken,600000)

    return {
        sendMessage: (message, opts = {}) => {
            return api.sendMessage(message, opts)
        }
    };
}

async function initDiscordCommands() {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);

    try {
        console.log('Started refreshing application (/) commands.');
        await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID), { body: commands });
        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error(error);
    }
}

async function main() {
    const chatGTP = await initChatGPT().catch(e=>{
        console.error(e)
        process.exit()
    })

    await initDiscordCommands()

    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.GuildIntegrations,
            GatewayIntentBits.DirectMessages,
            GatewayIntentBits.DirectMessageTyping,
            GatewayIntentBits.MessageContent,
        ],
        partials: [Partials.Channel]
    });

    client.on('ready', () => {
        console.log(`Logged in as ${client.user.tag}!`);
        console.log(new Date())
    });

    function askQuestion(question, cb,opts={}) {
        let tmr = setTimeout(() => {
            cb("Oppss, something went wrong! (Timeout)")
        }, 45000)

        chatGTP.sendMessage(question,opts).then((response) => {
            clearTimeout(tmr)
            cb(response)
        }).catch(() => {
            cb("Oppss, something went wrong! (Error)")
        })
    }

    async function splitAndSendResponse(resp,user){
        while(resp.length > 0){
            let end = Math.min(MAX_RESPONSE_CHUNK_LENGTH,resp.length)
            await user.send(resp.slice(0,end))
            resp = resp.slice(end,resp.length)
        }
    }

    client.on("messageCreate", async message => {
        if (process.env.ENABLE_DIRECT_MESSAGES !== "true" || message.channel.type != ChannelType.DM || message.author.bot) {
            return;
        }

        const user = message.author

        console.log("----Direct Message---")
        console.log("Date    : "+new Date())
        console.log("UserId  : "+user.id)
        console.log("User    : "+user.username)
        console.log("Message : "+message.content)
        console.log("--------------")

        let sentMessage = await user.send("Hmm, let me think...")
        askQuestion(message.content, (response) => {
            if(response.length >= MAX_RESPONSE_CHUNK_LENGTH){
                splitAndSendResponse(response,user)
            }else{
                sentMessage.edit(response)
            }
        })
    })

    client.on("interactionCreate", async interaction => {
        const question = interaction.options.getString("question")
        interaction.reply({ content: "let me think..." })
        try {
            askQuestion(question, (content) => {
                if(content.length >= MAX_RESPONSE_CHUNK_LENGTH){
                    interaction.editReply({ content:"The answer to this question is very long, so I will answer by dm." })
                    splitAndSendResponse(content,interaction.user)
                }else{
                    interaction.editReply({ content })
                }
            })
        } catch (e) {
            console.error(e)
        }

    });

    client.login(process.env.DISCORD_BOT_TOKEN);
}

main()