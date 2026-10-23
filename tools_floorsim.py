import random, statistics as S
def sim(F, P, cycles=9, pwin=0.7, trials=4000):
    clear=[];gap=[];d1=[];d2=[]
    for _ in range(trials):
        par={1:[random.randint(1,F) for _ in range(P)],2:[random.randint(1,F) for _ in range(P)]}
        done=None
        for c in range(cycles):
            w=1 if random.random()<pwin else 2
            if not par[w]: w=3-w
            if not par[w]: done=c; break
            cnt={}
            for f in par[w]: cnt[f]=cnt.get(f,0)+1
            m=max(cnt.values()); fl=random.choice([f for f in cnt if cnt[f]==m])
            for s in (1,2): par[s]=[f for f in par[s] if f!=fl]
        clear.append(done if done is not None else cycles+1)
        a=1-len(par[1])/P; b=1-len(par[2])/P; d1.append(a); d2.append(b)
    return S.mean(clear), S.mean(d1)*100, S.mean(d2)*100
print("parcels/player, floors -> avg stops to clear all (9 = 시간 끝), strong player delivered%, weak player delivered% (strong wins tug 70%)")
for P in (8,10,12):
    for F in (5,7,10,12,15):
        c,a,b=sim(F,P); print(f"P{P} F{F}: stops {c:.1f}  강 {a:.0f}%  약 {b:.0f}%")
