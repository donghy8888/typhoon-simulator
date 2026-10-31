/**
 * 西北太平洋知名台风简介与破坏损失摘要（公开信息整理）
 * 键优先 IBTrACS sid；亦支持 "YEAR|NAME" 回退。
 * 无条目时由 UI 用路径元数据自动摘要，破坏损失显示「暂无公开摘要」——禁止臆造伤亡数字。
 */
(function (global) {
  'use strict';

  /** @type {Object.<string,{zh?:string,intro:string,damage:string}>} */
  const BY_ID = {
    /* —— 近年强影响 —— */
    '2024244N09137': { /* YAGI 2024 */
      zh: '摩羯',
      intro: '2024 年第 11 号超强台风。生成于西北太平洋，西行穿过吕宋海峡一带后登陆华南沿海，强度极强、风雨范围大。',
      damage: '海南、广东、广西等地出现极端风雨与风暴潮；城市内涝、房屋损毁、电力与交通大面积中断；越南等地亦受重创。'
    },
    '2024253N11148': { /* BEBINCA 2024 */
      zh: '贝碧嘉',
      intro: '2024 年台风，影响华东沿海。路径偏北西行后登陆上海一带，是近年来直接显著影响长三角的台风之一。',
      damage: '上海及周边出现强风雨；城市运行、交通与部分设施受影响。'
    },
    '2024201N12133': { /* GAEMI 2024 */
      zh: '格美',
      intro: '2024 年台风。经台湾附近北上/西行，对台湾及福建等地带来强风雨。',
      damage: '台湾、福建等地出现暴雨与强风；局部洪涝与交通受阻。'
    },
    '2023201N13134': { /* DOKSURI 2023 */
      zh: '杜苏芮',
      intro: '2023 年第 5 号超强台风。西太平洋生成后西行登陆福建，残余环流深入内陆，北方多地出现极端暴雨。',
      damage: '福建等地强风雨致灾；京津冀等地遭遇极端强降雨与严重洪涝，城乡内涝、基础设施受损显著。'
    },
    '2023207N09141': { /* KHANUN 2023 */
      zh: '卡努',
      intro: '2023 年台风。路径曲折，长时间徘徊于琉球—东海一带，后北上影响朝鲜半岛与东北亚。',
      damage: '琉球、韩国等地出现强风雨；海上与沿岸活动受较大影响。'
    },
    '2023138N05151': { /* MAWAR 2023 */
      zh: '玛娃',
      intro: '2023 年超强台风。早期强度极强，影响关岛等地后转向，西北太平洋显著风暴之一。',
      damage: '关岛等地强风强降雨；航空与基础设施一度严重受扰。'
    },
    '2023234N18128': { /* SAOLA 2023 */
      zh: '苏拉',
      intro: '2023 年超强台风。靠近粤港澳大湾区沿海北上/西行，风雨威胁突出。',
      damage: '广东沿海与港澳出现强风大浪；公共交通与户外活动大面积暂停。'
    },
    '2023239N18144': { /* HAIKUI 2023 */
      zh: '海葵',
      intro: '2023 年台风。登陆华东后残余环流长时间滞留，给浙江、安徽等地带来极端暴雨。',
      damage: '华东多地严重洪涝、山体滑坡与交通中断；城乡积水与农业损失显著。'
    },
    '2023194N16123': { /* TALIM 2023 */
      zh: '泰利',
      intro: '2023 年台风。影响华南沿海，登陆广东一带。',
      damage: '广东等地强风雨；局部内涝与农业、水产受损。'
    },
    '2023279N08157': { /* BOLAVEN 2023 */
      zh: '布拉万',
      intro: '2023 年超强台风，西北太平洋高强度风暴，主要影响开阔洋面与岛屿地区。',
      damage: '海上与岛屿地区强风大浪；航运与渔业活动受影响。'
    },
    '2022239N22150': { /* HINNAMNOR 2022 */
      zh: '轩岚诺',
      intro: '2022 年超强台风。路径复杂，曾接近台湾与琉球，后北上影响朝鲜半岛。',
      damage: '韩国等地暴雨洪涝与强风；沿海与城市运行受冲击。'
    },
    '2022247N26147': { /* MUIFA 2022 */
      zh: '梅花',
      intro: '2022 年台风。北上后多次靠近华东沿海并登陆浙江—上海一带。',
      damage: '华东沿海强风雨；城市内涝、航班与轮渡大面积停运。'
    },
    '2022180N15117': { /* CHABA 2022 */
      zh: '暹芭',
      intro: '2022 年台风。登陆广东后深入内陆，华南出现大范围暴雨。',
      damage: '广东、广西等地洪涝与城乡积水；交通与农业受损。'
    },
    '2022264N17132': { /* NORU 2022 */
      zh: '奥鹿',
      intro: '2022 年超强台风。急速增强后登陆菲律宾吕宋，风雨极强。',
      damage: '菲律宾严重风雨灾害；房屋损毁、停电与交通中断。'
    },
    '2022254N24143': { /* NANMADOL 2022 */
      zh: '南玛都',
      intro: '2022 年超强台风，主要影响日本西南部与九州一带。',
      damage: '日本九州等地暴雨与强风；交通停运、局部洪涝。'
    },
    '2021197N17135': { /* IN-FA 2021 */
      zh: '烟花',
      intro: '2021 年台风。路径缓慢，长时间影响华东沿海并登陆浙江，风雨持续时间长。',
      damage: '浙江、上海等地严重内涝；高铁民航大面积停运，城市运行承压。'
    },
    '2021248N12141': { /* CHANTHU 2021 */
      zh: '灿都',
      intro: '2021 年超强台风。强度一度极强，靠近台湾北部与华东沿海。',
      damage: '台湾与华东沿海强风大浪；航运与沿岸设施受影响。'
    },
    '2021280N14137': { /* KOMPASU 2021 */
      zh: '圆规',
      intro: '2021 年台风。穿越南海影响海南、广东及越南北部。',
      damage: '海南、广东等地强风雨；局部洪涝与农业受损。'
    },
    '2020299N11144': { /* GONI 2020 */
      zh: '天鹅',
      intro: '2020 年超强台风（菲律宾命名超级台风）。登陆吕宋北部，近岸强度极强。',
      damage: '菲律宾严重破坏；大面积停电、房屋损毁与交通中断。'
    },
    '2020234N19123': { /* BAVI 2020 */
      zh: '巴威',
      intro: '2020 年台风，北上影响黄海与朝鲜半岛西部。',
      damage: '朝鲜半岛西部强风雨；农业与沿海设施受损。'
    },
    '2020239N13134': { /* MAYSAK 2020 */
      zh: '美莎克',
      intro: '2020 年台风，接连北上影响朝鲜半岛与东北地区。',
      damage: '韩国、朝鲜及中国东北部分地区强风雨与洪涝。'
    },
    '2020244N25146': { /* HAISHEN 2020 */
      zh: '海神',
      intro: '2020 年超强台风，高强度北上影响日本与朝鲜半岛。',
      damage: '日本西南与韩国等地强风强降雨；交通与电力受影响。'
    },
    '2019214N15134': { /* LEKIMA 2019 */
      zh: '利奇马',
      intro: '2019 年第 9 号超强台风。登陆浙江后北上影响华东大部，风雨范围广、致灾重。',
      damage: '浙江、山东等地严重洪涝与城乡积水；交通、农业与基础设施损失巨大。'
    },
    '2019278N16165': { /* HAGIBIS 2019 */
      zh: '海贝思',
      intro: '2019 年超强台风，主要袭击日本本州，带来极端暴雨。',
      damage: '日本关东甲信等地区严重洪涝与地质灾害；交通瘫痪、城市内涝显著。'
    },
    '2018250N12170': { /* MANGKHUT 2018 */
      zh: '山竹',
      intro: '2018 年第 22 号超强台风。横扫菲律宾吕宋北部后进入南海，强势登陆粤港澳大湾区沿海。',
      damage: '广东、广西、港澳等地极端狂风与风暴潮；大面积停电、树木倒伏、交通中断。'
    },
    '2018226N23128': { /* RUMBIA 2018 */
      zh: '温比亚',
      intro: '2018 年台风。登陆上海—浙江一带后深入内陆，华东出现强降雨。',
      damage: '山东、安徽等地严重洪涝；农田与城乡设施受损显著。'
    },
    '2018239N11161': { /* JEBI 2018 */
      zh: '飞燕',
      intro: '2018 年超强台风，登陆日本关西，是近年影响大阪一带最强风暴之一。',
      damage: '关西机场等设施严重受淹；交通与城市运行大面积中断。'
    },
    '2018294N08161': { /* YUTU 2018 */
      zh: '玉兔',
      intro: '2018 年超强台风，重创北马里亚纳群岛后西行影响菲律宾。',
      damage: '塞班等地建筑与基础设施严重损毁；菲律宾北部强风雨。'
    },
    '2017232N19130': { /* HATO 2017 */
      zh: '天鸽',
      intro: '2017 年台风。登陆珠三角西侧沿海，港澳出现罕见风暴潮与狂风。',
      damage: '澳门等地严重水浸与风损；广东沿海城市内涝、交通中断。'
    },
    '2016253N13144': { /* MERANTI 2016 */
      zh: '莫兰蒂',
      intro: '2016 年超强台风。曾达极高峰值强度，登陆福建厦门一带，是当地有观测记录以来最强登陆台风之一。',
      damage: '厦门等城市建筑、树木与电力设施严重损毁；交通瘫痪、城市运行受重创。'
    },
    '2016288N06146': { /* HAIMA 2016 */
      zh: '海马',
      intro: '2016 年超强台风。穿越菲律宾后进入南海并登陆广东。',
      damage: '菲律宾与粤东等地强风雨；局部洪涝与农业损失。'
    },
    '2016185N08145': { /* NEPARTAK 2016 */
      zh: '尼伯特',
      intro: '2016 年超强台风。登陆台湾台东一带，高山与东部风雨极强。',
      damage: '台湾东部严重风灾与泥石流；交通与观光设施受损。'
    },
    '2016211N11128': { /* NIDA 2016 */
      zh: '妮妲',
      intro: '2016 年台风，登陆深圳一带，影响粤港澳。',
      damage: '珠三角强风雨；航班轮渡停运、局部内涝。'
    },
    '2014190N08154': { /* RAMMASUN 2014 */
      zh: '威马逊',
      intro: '2014 年超强台风。登陆海南—广东—广西，是 1973 年以来登陆华南最强台风之一。',
      damage: '海南、广东、广西极端狂风与暴雨；房屋倒损、大面积停电、农业重创。'
    },
    '2014197N10137': { /* MATMO 2014 */
      zh: '麦德姆',
      intro: '2014 年台风。穿越台湾后登陆福建，华东出现强降雨。',
      damage: '台湾与福建等地风雨致灾；交通与农业受影响。'
    },
    '2013306N07162': { /* HAIYAN 2013 */
      zh: '海燕',
      intro: '2013 年超强台风（菲律宾超级台风）。以极高的近岸强度登陆菲律宾中部，是现代观测史上最强登陆热带气旋之一。',
      damage: '菲律宾中部灾难性破坏；大规模房屋损毁与基础设施瘫痪。'
    },
    '2013272N10135': { /* FITOW 2013 */
      zh: '菲特',
      intro: '2013 年台风。登陆福建后给浙江等地带来极端暴雨。',
      damage: '余姚等浙东地区严重内涝；城市长时间浸水、交通中断。'
    },
    '2013259N17132': { /* USAGI 2013 */
      zh: '天兔',
      intro: '2013 年超强台风，登陆粤东汕尾一带。',
      damage: '粤东强风雨与风暴潮；城乡设施与农业受损。'
    },
    '2013220N12137': { /* UTOR 2013 */
      zh: '尤特',
      intro: '2013 年超强台风，登陆粤西后深入广西等地。',
      damage: '广东、广西暴雨洪涝；山体滑坡与农业损失显著。'
    },
    '2013187N20156': { /* SOULIK 2013 */
      zh: '苏力',
      intro: '2013 年台风，登陆台湾后影响华东沿海。',
      damage: '台湾与福建等地强风雨；交通与农业受影响。'
    },
    '2012215N23146': { /* HAIKUI 2012 */
      zh: '海葵',
      intro: '2012 年台风，登陆浙江宁波一带，华东风雨显著。',
      damage: '浙江等地暴雨内涝；城市交通与供电受影响。'
    },
    '2012201N15129': { /* VICENTE 2012 */
      zh: '韦森特',
      intro: '2012 年台风，登陆广东台山一带，显著影响港澳。',
      damage: '珠三角强风大浪；航班轮渡停运、局部水浸。'
    },
    '2012232N13141': { /* BOLAVEN 2012 */
      zh: '布拉万',
      intro: '2012 年台风，北上影响朝鲜半岛西部。',
      damage: '朝鲜、韩国等地暴雨与强风；农业与沿海损失。'
    },
    '2010285N13145': { /* MEGI 2010 */
      zh: '鲇鱼',
      intro: '2010 年超强台风。登陆菲律宾后进入南海，再影响闽粤沿海。',
      damage: '菲律宾与福建等地严重风雨；交通中断、局部洪涝。'
    },
    '2010256N17137': { /* FANAPI 2010 */
      zh: '凡亚比',
      intro: '2010 年台风，登陆台湾与福建。',
      damage: '台湾南部严重水患；福建沿海强风雨。'
    },
    '2006216N07151': { /* SAOMAI 2006 */
      zh: '桑美',
      intro: '2006 年超强台风。登陆浙南苍南一带，是当地有记录以来最强登陆台风之一。',
      damage: '浙南闽东极端狂风与风暴潮；大量房屋倒损、电力通信中断。'
    },
    '2006188N10143': { /* BILIS 2006 */
      zh: '碧利斯',
      intro: '2006 年强热带风暴。强度并非最强，但登陆后给华南、江南带来极端持久暴雨。',
      damage: '湖南、广东、广西等地严重洪涝与泥石流；影响范围广。'
    },
    '2004219N15137': { /* RANANIM 2004 */
      zh: '云娜',
      intro: '2004 年强台风，登陆浙江温岭一带。',
      damage: '浙江沿海严重风灾与暴雨；房屋与农业损失显著。'
    },
    '2005268N19146': { /* LONGWANG 2005 */
      zh: '龙王',
      intro: '2005 年强台风，登陆台湾与福建。',
      damage: '台湾东部与福建沿海强风雨；局部洪涝。'
    },
    '2005211N09141': { /* MATSA 2005 */
      zh: '麦莎',
      intro: '2005 年台风，登陆浙江后北上影响华东。',
      damage: '浙江、江苏、山东等地暴雨洪涝；城市内涝与农业损失。'
    },
    '2005192N22155': { /* HAITANG 2005 */
      zh: '海棠',
      intro: '2005 年强台风，登陆台湾后影响福建。',
      damage: '台湾中部严重水患；福建沿海风雨。'
    },
    '2015273N12130': { /* MUJIGAE 2015 */
      zh: '彩虹',
      intro: '2015 年强台风，登陆广东湛江一带。',
      damage: '粤西极端狂风；房屋倒损、大树折断、供电中断。'
    },
    '2015211N13162': { /* SOUDELOR 2015 */
      zh: '苏迪罗',
      intro: '2015 年超强台风，登陆台湾与福建。',
      damage: '台湾多地暴雨与风灾；福建沿海强风雨。'
    },
    '2015180N09160': { /* CHAN-HOM 2015 */
      zh: '灿鸿',
      intro: '2015 年台风，靠近浙东沿海北上，华东风雨显著。',
      damage: '浙江等地强风雨；航运与城市运行受影响。'
    },
    '2015263N14148': { /* DUJUAN 2015 */
      zh: '杜鹃',
      intro: '2015 年强台风，登陆台湾后影响福建。',
      damage: '台湾东部风灾；福建沿海风雨。'
    },
    '2011346N03156': { /* WASHI 2011 */
      zh: '天鹰', /* Washi / Sendong — PH name more known; CMA 天鹰 */
      intro: '2011 年热带风暴，登陆菲律宾南部，降雨致灾极重。',
      damage: '菲律宾南部严重洪涝与泥石流；城乡受灾显著。'
    },
    '2001206N14134': { /* TORAJI 2001 */
      zh: '桃芝',
      intro: '2001 年台风，重创台湾东部与南部山区。',
      damage: '台湾严重泥石流与山洪；山区交通与村镇受重创。'
    },
    '2016230N25160': { /* LIONROCK 2016 */
      zh: '狮子山',
      intro: '2016 年台风，路径异常，后期影响日本东北与俄罗斯远东。',
      damage: '日本北海道等地暴雨洪涝；局部灾害突出。'
    },
    '2016269N15165': { /* CHABA 2016 */
      zh: '暹芭',
      intro: '2016 年强台风，主要影响琉球与朝鲜半岛南部。',
      damage: '韩国南部暴雨与强风；交通与城乡设施受影响。'
    },
    '2017236N15129': { /* PAKHAR 2017 */
      zh: '帕卡',
      intro: '2017 年台风，紧随天鸽之后影响珠三角。',
      damage: '粤港澳再度强风雨；交通与户外活动受限。'
    },
    '2017304N11127': { /* DAMREY 2017 */
      zh: '达维',
      intro: '2017 年台风，登陆越南中部，带来严重暴雨。',
      damage: '越南中部严重洪涝；房屋与农业受损。'
    },
    '2014275N06166': { /* VONGFONG 2014 */
      zh: '黄蜂',
      intro: '2014 年超强台风，高强度影响西北太平洋岛屿与日本以南洋面。',
      damage: '岛屿与海上强风大浪；航运受影响。'
    },
    '2014209N12152': { /* HALONG 2014 */
      zh: '哈隆',
      intro: '2014 年超强台风，后期影响日本。',
      damage: '日本部分地区强风雨；交通受阻。'
    },
    '2014254N10142': { /* KALMAEGI 2014 */
      zh: '海鸥',
      intro: '2014 年台风，登陆广东雷州半岛并影响广西、越南北部。',
      damage: '粤西桂南暴雨洪涝；农业与城乡设施受损。'
    },
    '2020129N07134': { /* VONGFONG 2020 */
      zh: '黄蜂',
      intro: '2020 年台风，登陆菲律宾后影响南海北部。',
      damage: '菲律宾强风雨；局部洪涝与交通中断。'
    },
    '2022285N17140': { /* NESAT 2022 */
      zh: '纳沙',
      intro: '2022 年台风，与随后的「海高斯」等接连影响南海北部。',
      damage: '华南沿海强风雨；航运与渔业受影响。'
    },
    '2011266N13139': { /* NESAT 2011 */
      zh: '纳沙',
      intro: '2011 年强台风，登陆海南文昌一带。',
      damage: '海南强风雨与洪涝；交通与农业受损。'
    },
    '2012225N16133': { /* KAI-TAK 2012 */
      zh: '启德',
      intro: '2012 年台风，登陆广东后影响广西与越南北部。',
      damage: '华南暴雨洪涝；城乡积水与农业损失。'
    },
    '2012263N15141': { /* JELAWAT 2012 */
      zh: '杰拉华',
      intro: '2012 年超强台风，高强度西行后北折，主要影响洋面与琉球一带。',
      damage: '海上狂风巨浪；岛屿强风雨。'
    },
    '2019268N10155': { /* MITAG 2019 */
      zh: '米娜',
      intro: '2019 年台风，影响琉球与华东沿海。',
      damage: '浙沪等地风雨；航运与城市运行受影响。'
    },
    '2019242N14180': { /* FAXAI 2019 */
      zh: '法茜',
      intro: '2019 年台风，登陆日本关东，东京一带强风显著。',
      damage: '关东大面积停电与交通中断。'
    },
    '2018271N06154': { /* KONG-REY 2018 */
      zh: '康妮',
      intro: '2018 年超强台风，靠近台湾与日本南部。',
      damage: '台湾与琉球强风雨；海上活动受影响。'
    },
    '2018263N12146': { /* TRAMI 2018 */
      zh: '潭美',
      intro: '2018 年强台风，影响琉球与日本西南。',
      damage: '冲绳与日本西南强风雨；交通停运。'
    },
    '2015285N14151': { /* KOPPU 2015 */
      zh: '巨爵',
      intro: '2015 年强台风，登陆菲律宾吕宋。',
      damage: '菲律宾强风雨与山体滑坡；农业与电力受损。'
    },
    '2016355N07146': { /* NOCK-TEN 2016 */
      zh: '洛坦',
      intro: '2016 年末超强台风，登陆菲律宾吕宋东部。',
      damage: '菲律宾圣诞期间严重风雨；停电与交通中断。'
    },
    '2016287N12131': { /* SARIKA 2016 */
      zh: '莎莉嘉',
      intro: '2016 年强台风，登陆海南文昌并影响华南。',
      damage: '海南强风雨；广东广西暴雨洪涝。'
    },
    '2005248N08142': { /* KHANUN 2005 */
      zh: '卡努',
      intro: '2005 年台风，登陆浙江后影响华东。',
      damage: '浙江等地暴雨；城乡与农业受影响。'
    },
    '2005237N14148': { /* TALIM 2005 */
      zh: '泰利',
      intro: '2005 年强台风，登陆台湾与福建。',
      damage: '台湾暴雨洪涝；福建沿海风雨。'
    },
    '2017252N14147': { /* TALIM 2017 */
      zh: '泰利',
      intro: '2017 年台风，靠近华东沿海北上。',
      damage: '浙闽沿海风雨；航运与渔业受影响。'
    },
    '2017284N15134': { /* KHANUN 2017 */
      zh: '卡努',
      intro: '2017 年台风，登陆越南后影响南海北部。',
      damage: '越南北部与广东西部风雨。'
    },
  };

  // remove empty / null placeholders
  Object.keys(BY_ID).forEach(function (k) {
    if (!BY_ID[k] || !BY_ID[k].intro) delete BY_ID[k];
  });

  function keyYearName(year, name) {
    return String(year | 0) + '|' + String(name || '').toUpperCase().replace(/-/g, '');
  }

  const BY_YEAR_NAME = Object.create(null);
  // secondary index filled lazily from BY_ID when year/name known via lookup helpers

  function getCurated(id, year, name) {
    if (id && BY_ID[id]) return BY_ID[id];
    if (year != null && name) {
      const k = keyYearName(year, name);
      if (BY_YEAR_NAME[k]) return BY_YEAR_NAME[k];
      // scan BY_ID values is useless without year; try match via global name table only for zh
    }
    return null;
  }

  function autoSummary(storm, extras) {
    extras = extras || {};
    const H = global.TyHistory;
    const NZ = global.TyNamesZh;
    const name = (storm && storm.name) || extras.name || 'UNNAMED';
    const year = (storm && (storm.season || storm.year)) || extras.year || '';
    const zh = (H && H.chineseName && storm) ? H.chineseName(storm)
      : (NZ && NZ.chineseName ? NZ.chineseName(name) : null);
    const maxV = storm && storm.maxVmax != null ? storm.maxVmax
      : (extras.maxVmax != null ? extras.maxVmax : null);
    const pts = (storm && storm.points) || [];
    let durationH = extras.durationH;
    if (durationH == null && pts.length >= 2) {
      const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
      if (typeof t0 === 'number' && typeof t1 === 'number') durationH = Math.max(0, t1 - t0);
      else if (typeof t0 === 'string' && typeof t1 === 'string') {
        const a = Date.parse(t0.replace(' ', 'T'));
        const b = Date.parse(t1.replace(' ', 'T'));
        if (isFinite(a) && isFinite(b)) durationH = Math.max(0, (b - a) / 3600000);
      }
    }
    const landfalls = extras.landfalls;
    const title = (zh ? zh + '（' + name + '）' : name) + (year ? ' · ' + year : '');
    let intro = title + '。';
    if (maxV != null) intro += '峰值风速约 ' + Number(maxV).toFixed(0) + ' m/s。';
    if (durationH != null && isFinite(durationH)) {
      intro += '路径时长约 ' + (durationH / 24).toFixed(1) + ' 天。';
    }
    if (landfalls && landfalls.length) {
      intro += '侦测到约 ' + landfalls.length + ' 次登陆迹象。';
    } else if (pts.length) {
      intro += '共 ' + pts.length + ' 个最佳路径点。';
    }
    return {
      title: title,
      zh: zh,
      intro: intro,
      damage: '破坏损失：暂无公开摘要',
      curated: false
    };
  }

  function buildPanelModel(storm, extras) {
    extras = extras || {};
    const id = (storm && storm.id) || extras.id || null;
    const name = (storm && storm.name) || extras.name || '';
    const year = (storm && (storm.season || storm.year)) || extras.year;
    const curated = getCurated(id, year, name);
    const H = global.TyHistory;
    const NZ = global.TyNamesZh;
    const zh = (curated && curated.zh)
      || ((H && storm && H.chineseName) ? H.chineseName(storm) : null)
      || (NZ && NZ.chineseName ? NZ.chineseName(name) : null);
    const maxV = storm && storm.maxVmax != null ? storm.maxVmax : extras.maxVmax;
    const title = (zh ? (year ? year + ' ' + zh : zh) : (year ? year + ' ' + name : name));
    if (curated) {
      return {
        id: id,
        title: title,
        name: name,
        zh: zh,
        year: year,
        maxVmax: maxV,
        intro: curated.intro,
        damage: curated.damage.indexOf('破坏损失') === 0 ? curated.damage : ('破坏损失：' + curated.damage),
        curated: true
      };
    }
    const auto = autoSummary(storm, extras);
    auto.id = id;
    auto.title = title || auto.title;
    auto.name = name;
    auto.year = year;
    auto.maxVmax = maxV;
    return auto;
  }

  function curatedCount() {
    return Object.keys(BY_ID).length;
  }

  global.TyIntros = {
    BY_ID: BY_ID,
    getCurated: getCurated,
    autoSummary: autoSummary,
    buildPanelModel: buildPanelModel,
    curatedCount: curatedCount
  };
})(typeof window !== 'undefined' ? window : globalThis);
